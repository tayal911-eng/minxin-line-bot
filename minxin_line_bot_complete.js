// =========================================================
// MinXin 健身房 減重挑戰 LINE Bot
// Heroku 部署版本
// =========================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

// =========================================================
// 環境變數設定
// =========================================================

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// 初始化Supabase客戶端
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =========================================================
// LINE Webhook Signature 驗證
// =========================================================

function verifyLineSignature(body, signature) {
  const hash = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(body, 'utf8')
    .digest('base64');
  return hash === signature;
}

// =========================================================
// LINE Bot Webhook 端點
// =========================================================

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const body = req.rawBody || JSON.stringify(req.body);

  // 驗證LINE簽名
  if (!verifyLineSignature(body, signature)) {
    console.log('❌ 簽名驗證失敗');
    return res.status(401).send('Invalid signature');
  }

  // 處理多個事件
  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleTextMessage(event);
    }
  }

  res.status(200).send('OK');
});

// =========================================================
// 處理文字訊息
// =========================================================

async function handleTextMessage(event) {
  const userText = event.message.text;
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  console.log(`收到訊息: ${userText} (User: ${userId})`);

  // 檢查是否為簽到訊息（以/簽到開頭）
  if (userText.startsWith('/簽到')) {
    await processCheckIn(event, userText, userId, replyToken);
  } else if (userText === '/排行榜') {
    await sendLeaderboard(event, replyToken);
  } else if (userText === '/我的進度') {
    await sendMyProgress(event, userId, replyToken);
  } else {
    // 其他訊息，給予幫助提示
    await sendReplyMessage(replyToken, '👋 歡迎使用MinXin減重挑戰系統！\n\n可用指令：\n/簽到 - 簽到（格式見下方）\n/排行榜 - 查看RPG排行榜\n/我的進度 - 查看個人進度\n\n簽到格式:\n/簽到\n早餐：粥配菜\n午餐：便當\n晚餐：白飯\n運動：有');
  }
}

// =========================================================
// 處理簽到訊息
// =========================================================

async function processCheckIn(event, userText, userId, replyToken) {
  try {
    // 解析簽到內容
    const lines = userText.split('\n');
    let breakfast = '';
    let lunch = '';
    let dinner = '';
    let exercise = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('早餐：')) breakfast = line.replace('早餐：', '').trim();
      if (line.startsWith('午餐：')) lunch = line.replace('午餐：', '').trim();
      if (line.startsWith('晚餐：')) dinner = line.replace('晚餐：', '').trim();
      if (line.startsWith('運動：')) {
        const exerciseText = line.replace('運動：', '').trim();
        exercise = exerciseText === '有' || exerciseText === '有運動';
      }
    }

    // 從LINE userId取得或建立學員
    let { data: student, error: studentError } = await supabase
      .from('students_minxin')
      .select('id, student_name')
      .eq('line_id', userId)
      .single();

    if (studentError || !student) {
      // 如果沒有對應學員，建立一個
      const { data: newStudent, error: insertError } = await supabase
        .from('students_minxin')
        .insert([
          {
            student_name: `使用者_${userId.substring(0, 10)}`,
            line_id: userId,
            current_level: 1,
            total_exp: 0
          }
        ])
        .select()
        .single();

      if (insertError) {
        await sendReplyMessage(replyToken, '❌ 建立學員失敗，請聯絡教練');
        console.error('插入學員錯誤:', insertError);
        return;
      }
      student = newStudent;
    }

    // 取得今天的日期
    const today = new Date().toISOString().split('T')[0];

    // 檢查今天是否已簽到
    const { data: existingAttendance } = await supabase
      .from('attendance_minxin')
      .select('id')
      .eq('student_id', student.id)
      .eq('check_in_date', today)
      .single();

    if (existingAttendance) {
      await sendReplyMessage(replyToken, `⚠️ ${student.student_name}，你今天已經簽到過囉！`);
      return;
    }

    // 新增簽到紀錄
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance_minxin')
      .insert([
        {
          student_id: student.id,
          check_in_date: today,
          breakfast,
          lunch,
          dinner,
          exercise
        }
      ])
      .select()
      .single();

    if (attendanceError) {
      await sendReplyMessage(replyToken, '❌ 簽到失敗，請稍後重試');
      console.error('插入簽到錯誤:', attendanceError);
      return;
    }

    // 更新RPG經驗值
    let expGain = 10; // 簽到 +10
    if (exercise) expGain += 15; // 有運動 +15

    const { error: rpgError } = await supabase.rpc('add_rpg_exp', {
      p_student_id: student.id,
      p_check_in_exp: 10,
      p_exercise_exp: exercise ? 15 : 0
    });

    // 如果沒有RPC函數，直接更新
    if (rpgError) {
      const { data: rpg } = await supabase
        .from('rpg_progress_minxin')
        .select('*')
        .eq('student_id', student.id)
        .single();

      if (rpg) {
        await supabase
          .from('rpg_progress_minxin')
          .update({
            check_in_exp: rpg.check_in_exp + 10,
            exercise_exp: rpg.exercise_exp + (exercise ? 15 : 0),
            total_exp: rpg.total_exp + expGain,
            last_check_in_date: today
          })
          .eq('student_id', student.id);
      }
    }

    // 回覆成功訊息
    const replyMsg = `✅ 簽到成功！\n${student.student_name}\n\n早餐：${breakfast || '未記錄'}\n午餐：${lunch || '未記錄'}\n晚餐：${dinner || '未記錄'}\n運動：${exercise ? '✅ 有' : '❌ 無'}\n\n💰 獲得經驗值：+${expGain} EXP`;
    await sendReplyMessage(replyToken, replyMsg);

  } catch (error) {
    console.error('簽到處理錯誤:', error);
    await sendReplyMessage(replyToken, '❌ 簽到出錯，請聯絡教練');
  }
}

// =========================================================
// 排行榜
// =========================================================

async function sendLeaderboard(event, replyToken) {
  try {
    const { data: leaderboard, error } = await supabase
      .from('rpg_leaderboard_minxin')
      .select('*')
      .limit(10);

    if (error || !leaderboard || leaderboard.length === 0) {
      await sendReplyMessage(replyToken, '📊 目前還沒有排行榜資料');
      return;
    }

    let msg = '🏆 RPG 排行榜 Top 10\n\n';
    leaderboard.forEach((entry, idx) => {
      msg += `${idx + 1}. ${entry.student_name}\n`;
      msg += `   Lv.${entry.current_level} | ${entry.total_exp} EXP\n`;
      msg += `   簽到：${entry.total_check_ins} 天 | 運動：${entry.exercise_days} 天\n\n`;
    });

    await sendReplyMessage(replyToken, msg);
  } catch (error) {
    console.error('排行榜錯誤:', error);
    await sendReplyMessage(replyToken, '❌ 無法取得排行榜');
  }
}

// =========================================================
// 個人進度
// =========================================================

async function sendMyProgress(event, userId, replyToken) {
  try {
    const { data: student } = await supabase
      .from('students_minxin')
      .select('*')
      .eq('line_id', userId)
      .single();

    if (!student) {
      await sendReplyMessage(replyToken, '❌ 找不到你的帳號，請先簽到');
      return;
    }

    const { data: rpg } = await supabase
      .from('rpg_progress_minxin')
      .select('*')
      .eq('student_id', student.id)
      .single();

    const msg = `📈 ${student.student_name} 的進度\n\n等級：Lv.${student.current_level}\n經驗值：${student.total_exp} EXP\n\n簽到次數：${rpg?.check_in_exp / 10 || 0} 次\n運動天數：${rpg?.exercise_exp / 15 || 0} 天`;
    await sendReplyMessage(replyToken, msg);
  } catch (error) {
    console.error('進度查詢錯誤:', error);
    await sendReplyMessage(replyToken, '❌ 無法取得個人進度');
  }
}

// =========================================================
// 發送LINE回覆訊息
// =========================================================

async function sendReplyMessage(replyToken, text) {
  try {
    const response = await fetch('https://api.line.biz/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text
          }
        ]
      })
    });

    if (!response.ok) {
      console.error(`LINE回覆失敗: ${response.status}`);
    }
  } catch (error) {
    console.error('發送LINE訊息錯誤:', error);
  }
}

// =========================================================
// 健康檢查端點
// =========================================================

app.get('/health', (req, res) => {
  res.status(200).send('Bot is running');
});

// =========================================================
// 啟動伺服器
// =========================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ MinXin Bot 已在 Port ${PORT} 運行`);
});

// =========================================================
// Express middleware 用來取得原始body（LINE簽名驗證需要）
// =========================================================

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);
