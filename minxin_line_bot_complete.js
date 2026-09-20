const express = require('express');
const LINE = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// LINE Bot SDK 導入
const { Client, middleware } = LINE;

// 設定全局 WebSocket，讓 Supabase 在 Node.js 環境中使用
global.WebSocket = ws;

const app = express();

// LINE Bot 設定
const lineConfig = {
  channelId: '2009523446',
  channelSecret: '043703672979c8bc03b016f09dc69c3d',
  channelAccessToken: 'pma4dRHbAsfzdVIdP2imlcowfJZ2gVbN0/EsC+RgQVG4Rxxx2HSASmOXkoe0eGbhE+eueOiescyyJCjVZgpi/zcKKF7s2vNWWAc+OicD3kYEh4noMvtxG6mCfrHTrdNIgtAloBf8gDjTnOnEI9zNeAdB04t89/1O/w1cDnyilFU='
};

// Supabase 設定（含 WebSocket 支持）
const supabaseUrl = 'https://jxbfxtppawnqscmkvbue.supabase.co';
const supabaseKey = 'sb_publishable_aRp3k34gK-ntEDUs4EHi2w_qqd-yrx-';
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

// LINE Client
const client = new Client(lineConfig);

// Middleware
app.use(middleware(lineConfig));

// 健康檢查
app.get('/', (req, res) => {
  res.send('MinXin 減重挑戰 LINE Bot 運行中！');
});

// Webhook 處理
app.post('/callback', async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(event => handleEvent(event)));
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).end();
  }
});

// 事件處理函數
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text;
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  // 檢查是否是簽到指令
  if (text.includes('/簽到') || text.includes('/签到')) {
    return handleCheckIn(text, userId, replyToken);
  }

  // 排行榜指令
  if (text.includes('/排行榜')) {
    return handleLeaderboard(replyToken);
  }

  // 我的進度指令
  if (text.includes('/我的進度') || text.includes('/我的进度')) {
    return handleMyProgress(userId, replyToken);
  }

  return Promise.resolve(null);
}

// 處理簽到
async function handleCheckIn(text, userId, replyToken) {
  try {
    // 解析簽到資訊
    const checkInData = parseCheckIn(text);
    
    if (!checkInData) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '簽到格式不正確。請按照以下格式：\n/簽到\n早餐：粥配菜\n午餐：便當\n晚餐：白飯\n運動：有'
      });
    }

    // 先取得學員資訊（根據 LINE userId）
    const { data: studentData, error: studentError } = await supabase
      .from('students_minxin')
      .select('id, name')
      .eq('line_user_id', userId)
      .single();

    let studentId;
    if (!studentData) {
      // 如果沒有記錄，先創建
      const { data: newStudent, error: createError } = await supabase
        .from('students_minxin')
        .insert({
          line_user_id: userId,
          name: `學員_${userId.slice(-6)}`
        })
        .select()
        .single();

      if (createError) throw createError;
      studentId = newStudent.id;
    } else {
      studentId = studentData.id;
    }

    // 今天的日期
    const today = new Date().toISOString().split('T')[0];

    // 存儲簽到記錄到 attendance_minxin
    const { error: insertError } = await supabase
      .from('attendance_minxin')
      .insert({
        student_id: studentId,
        date: today,
        breakfast: checkInData.breakfast || null,
        lunch: checkInData.lunch || null,
        dinner: checkInData.dinner || null,
        exercise: checkInData.exercise ? '有' : '無',
        notes: checkInData.notes || null,
        check_in_time: new Date().toISOString()
      });

    if (insertError) throw insertError;

    // 計算經驗值並更新 RPG Progress
    const expGain = 10 + (checkInData.exercise ? 15 : 0); // 簽到 10 exp，運動 +15 exp
    
    const { data: rpgData } = await supabase
      .from('rpg_progress_minxin')
      .select('current_exp, level')
      .eq('student_id', studentId)
      .single();

    if (rpgData) {
      let newExp = (rpgData.current_exp || 0) + expGain;
      let newLevel = rpgData.level || 1;

      // 每 100 exp 升一級
      if (newExp >= 100) {
        newLevel += Math.floor(newExp / 100);
        newExp = newExp % 100;
      }

      await supabase
        .from('rpg_progress_minxin')
        .update({
          current_exp: newExp,
          level: newLevel,
          last_check_in: today
        })
        .eq('student_id', studentId);
    } else {
      // 創建新的 RPG 記錄
      await supabase
        .from('rpg_progress_minxin')
        .insert({
          student_id: studentId,
          level: 1,
          current_exp: expGain,
          last_check_in: today
        });
    }

    // 回覆成功訊息
    const successMsg = `✅ 簽到成功！\n早餐：${checkInData.breakfast || '未填'}\n午餐：${checkInData.lunch || '未填'}\n晚餐：${checkInData.dinner || '未填'}\n運動：${checkInData.exercise ? '有' : '無'}\n\n獲得經驗值：+${expGain} EXP`;
    
    return client.replyMessage(replyToken, {
      type: 'text',
      text: successMsg
    });

  } catch (error) {
    console.error('Check-in error:', error);
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '簽到失敗，請稍後重試。'
    });
  }
}

// 解析簽到資訊
function parseCheckIn(text) {
  try {
    const lines = text.split('\n').map(l => l.trim());
    const result = {
      breakfast: null,
      lunch: null,
      dinner: null,
      exercise: false,
      notes: null
    };

    for (const line of lines) {
      if (line.includes('早餐') || line.includes('早饭')) {
        result.breakfast = line.split(/[：:]/)[1]?.trim() || '';
      } else if (line.includes('午餐') || line.includes('午饭')) {
        result.lunch = line.split(/[：:]/)[1]?.trim() || '';
      } else if (line.includes('晚餐') || line.includes('晚饭')) {
        result.dinner = line.split(/[：:]/)[1]?.trim() || '';
      } else if (line.includes('運動') || line.includes('运动') || line.includes('運動')) {
        const exerciseText = line.split(/[：:]/)[1]?.trim().toLowerCase() || '';
        result.exercise = exerciseText === '有' || exerciseText === 'yes' || exerciseText === 'y';
      }
    }

    // 至少要有一個欄位被填寫
    if (result.breakfast || result.lunch || result.dinner) {
      return result;
    }
    return null;
  } catch (error) {
    console.error('Parse error:', error);
    return null;
  }
}

// 處理排行榜
async function handleLeaderboard(replyToken) {
  try {
    const { data, error } = await supabase
      .from('rpg_leaderboard_minxin')
      .select('*')
      .order('level', { ascending: false })
      .order('current_exp', { ascending: false })
      .limit(10);

    if (error) throw error;

    let leaderboardText = '🏆 排行榜前 10 名：\n\n';
    data.forEach((item, index) => {
      leaderboardText += `${index + 1}. ${item.name || '匿名'} - 等級 ${item.level} (EXP: ${item.current_exp || 0})\n`;
    });

    return client.replyMessage(replyToken, {
      type: 'text',
      text: leaderboardText
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '查詢排行榜失敗，請稍後重試。'
    });
  }
}

// 處理個人進度
async function handleMyProgress(userId, replyToken) {
  try {
    const { data: studentData } = await supabase
      .from('students_minxin')
      .select('id, name')
      .eq('line_user_id', userId)
      .single();

    if (!studentData) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '尚未找到你的記錄，請先簽到。'
      });
    }

    const { data: rpgData } = await supabase
      .from('rpg_progress_minxin')
      .select('*')
      .eq('student_id', studentData.id)
      .single();

    if (!rpgData) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '尚未找到你的進度，請先簽到。'
      });
    }

    const progressText = `📊 你的進度\n\n等級：${rpgData.level}\nEXP：${rpgData.current_exp || 0}/100\n最後簽到：${rpgData.last_check_in || '尚未簽到'}`;

    return client.replyMessage(replyToken, {
      type: 'text',
      text: progressText
    });
  } catch (error) {
    console.error('Progress error:', error);
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '查詢進度失敗，請稍後重試。'
    });
  }
}

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot 運行在 port ${PORT}`);
});
