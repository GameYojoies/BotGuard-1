require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();
const port = process.env.PORT || 3000;

// กำหนดค่า Channel Access Token และ Channel Secret จากไฟล์ .env
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// สร้าง LINE client
const client = new line.Client(config);

// ที่เก็บแอดมินหลัก แอดมินรอง และผู้ใช้ที่ถูกแบนในหน่วยความจำ
// (คำแนะนำ: ควรเปลี่ยนไปใช้ฐานข้อมูลเพื่อให้ข้อมูลอยู่ถาวรเมื่อบอทรีสตาร์ท)
const mainAdmins = [];
const subAdmins = [];
const blacklistedUsers = [];

// ฟังก์ชันตรวจสอบว่าเป็นแอดมินหลักหรือแอดมินรอง
function isAdmin(userId) {
  return mainAdmins.includes(userId) || subAdmins.includes(userId);
}

// ฟังก์ชันเพิ่มแอดมินหลัก
function addMainAdmin(userId) {
  if (!mainAdmins.includes(userId)) {
    mainAdmins.push(userId);
    // ถ้าเคยเป็นแอดมินรอง ให้เอาออกจากรายชื่อแอดมินรอง
    const index = subAdmins.indexOf(userId);
    if (index > -1) {
      subAdmins.splice(index, 1);
    }
  }
}

// ฟังก์ชันเพิ่มแอดมินรอง
function addSubAdmin(userId) {
  if (!subAdmins.includes(userId)) {
    subAdmins.push(userId);
    // ถ้าเคยเป็นแอดมินหลัก ให้เอาออกจากรายชื่อแอดมินหลัก
    const index = mainAdmins.indexOf(userId);
    if (index > -1) {
      mainAdmins.splice(index, 1);
    }
  }
}

// ฟังก์ชันลบผู้ใช้ออกจากตำแหน่งแอดมิน (ทั้งหลักและรอง)
function removeAdmin(userId) {
    let removed = false;
    const mainIndex = mainAdmins.indexOf(userId);
    if (mainIndex > -1) {
        mainAdmins.splice(mainIndex, 1);
        removed = true;
    }
    const subIndex = subAdmins.indexOf(userId);
    if (subIndex > -1) {
        subAdmins.splice(subIndex, 1);
        removed = true;
    }
    return removed;
}

// ฟังก์ชันเพิ่มผู้ใช้ในบัญชีดำ (แบน)
function addBlacklistedUser(userId) {
    if (!blacklistedUsers.includes(userId)) {
        blacklistedUsers.push(userId);
        // ถ้าถูกแบน ก็ให้เอาออกจากตำแหน่งแอดมินด้วย
        removeAdmin(userId);
    }
}

// ฟังก์ชันลบผู้ใช้จากบัญชีดำ (ปลดแบน)
function removeBlacklistedUser(userId) {
    const index = blacklistedUsers.indexOf(userId);
    if (index > -1) {
        blacklistedUsers.splice(index, 1);
        return true;
    }
    return false;
}

// สถานะการอนุญาตเชิญสมาชิกใหม่ (เก็บในหน่วยความจำ)
let allowInvite = true; // ค่าเริ่มต้นคืออนุญาตให้เชิญได้

// Webhook endpoint สำหรับรับข้อความจาก LINE
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// ฟังก์ชันสำหรับจัดการเหตุการณ์ต่างๆ
async function handleEvent(event) {
  // กรณีมีสมาชิกใหม่เข้าร่วมกลุ่ม (memberJoined)
  if (event.type === 'memberJoined') {
    const inviterId = event.source.userId; // User ID ของคนเชิญ (ถ้ามี)
    const groupId = event.source.groupId || event.source.roomId; // Group ID หรือ Room ID

    // รับ User ID ของสมาชิกใหม่ที่เข้าร่วม
    const newMembers = event.joined.members.map(member => member.userId);

    // ตรวจสอบว่าคนเชิญไม่ใช่แอดมิน และไม่อนุญาตให้เชิญ
    if (!allowInvite && !isAdmin(inviterId)) {
        // ตรวจสอบเพิ่มเติมว่าคนเชิญไม่ใช่คนที่เป็นสมาชิกใหม่ที่เพิ่งเข้ามาเอง
        if (inviterId && !newMembers.includes(inviterId)) {
            try {
                await client.kickGroupMember(groupId, inviterId);

                await client.pushMessage(groupId, {
                    type: 'text',
                    text: `คุณไม่อนุญาตให้เชิญสมาชิก กรุณาอย่าเชิญอีก`
                });
                console.log(`ดีดผู้ใช้ ${inviterId} ออกจากกลุ่ม ${groupId} เนื่องจากเชิญโดยไม่ได้รับอนุญาต`);
            } catch (error) {
                console.error('เกิดข้อผิดพลาดในการดีดสมาชิก:', error);
                await client.pushMessage(groupId, {
                    type: 'text',
                    text: `ไม่สามารถดีดผู้ใช้ ${inviterId} ออกได้ (เกิดข้อผิดพลาด)`
                });
            }
        }
    }
    // ตรวจสอบว่ามีสมาชิกใหม่คนใดอยู่ในบัญชีดำหรือไม่
    else if (blacklistedUsers.some(bannedId => newMembers.includes(bannedId))) {
        const bannedJoinedUsers = newMembers.filter(userId => blacklistedUsers.includes(userId));
        for (const bannedUserId of bannedJoinedUsers) {
            try {
                await client.kickGroupMember(groupId, bannedUserId);
                await client.pushMessage(groupId, {
                    type: 'text',
                    text: `ผู้ใช้ ${bannedUserId} ถูกแบนและถูกดีดออกจากกลุ่มแล้ว.`
                });
                console.log(`ดีดผู้ใช้ที่ถูกแบน ${bannedUserId} ออกจากกลุ่ม ${groupId}`);
            } catch (error) {
                console.error(`เกิดข้อผิดพลาดในการดีดผู้ใช้ที่ถูกแบน ${bannedUserId}:`, error);
                await client.pushMessage(groupId, {
                    type: 'text',
                    text: `ไม่สามารถดีดผู้ใช้ที่ถูกแบน ${bannedUserId} ออกได้ (เกิดข้อผิดพลาด)`
                });
            }
        }
    }
    return null; // ไม่ต้องตอบกลับสำหรับเหตุการณ์ memberJoined
  }

  // ไม่สนใจเหตุการณ์ที่ไม่ใช่ข้อความ หรือไม่ใช่ข้อความแบบ Text
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userMessage = event.message.text.trim();
  const senderUserId = event.source.userId;
  const replyToken = event.replyToken;

  // --- คำสั่งสำหรับจัดการแอดมิน ---

  // คำสั่ง: ตั้ง @<mention> (ตั้งแอดมินหลัก)
  // ใครก็ได้สามารถตั้งแอดมินหลักคนแรกได้ หลังจากนั้น แอดมินหลักคนปัจจุบันสามารถตั้งคนอื่นได้
if (userMessage.startsWith('ตั้ง ')) {
    // ตรวจสอบว่ามีข้อมูล mention และมีสมาชิกที่ถูก mention จริงๆ
    if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
      const mentioneesUserId = event.message.mention.mentionees[0].userId;

      // ตรวจสอบรูปแบบคำสั่ง: "ตั้ง @<mention>"
      if (userMessage.startsWith('ตั้ง @')) {
          // ถ้ายังไม่มีแอดมินหลักเลย ใครก็ได้สามารถตั้งคนแรกได้
          // หรือ ถ้าผู้ส่งข้อความSเป็นแอดมินหลักอยู่แล้ว ก็สามารถตั้งคนใหม่ได้
          if (mainAdmins.length === 0 || mainAdmins.includes(senderUserId)) {
              addMainAdmin(mentioneesUserId);
              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: `ตั้งแอดมินหลักเรียบร้อยแล้ว: ${mentioneesUserId}`
              });
          } else {
              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: 'เฉพาะแอดมินหลักเท่านั้นที่ตั้งแอดมินหลักได้ครับ'
              });
          }
      } else {
          // กรณีมี @mention แต่คำสั่งไม่ได้ขึ้นต้นด้วย "ตั้ง @" เป๊ะๆ (เช่น "ตั้งเฉยๆ @")
          // หรืออาจจะเป็นคำสั่งอื่นที่ไม่ได้ตั้งใจให้เป็นแอดมินหลัก
          console.log('--- Log: มี mention แต่คำสั่งไม่ตรงรูปแบบ "ตั้ง @" ---');
          console.log('userMessage:', userMessage);
          console.log('event.message.mention:', JSON.stringify(event.message.mention, null, 2));
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'คำสั่งไม่ถูกต้องครับ ลองใช้ "ตั้ง @ชื่อสมาชิก" เพื่อตั้งแอดมินหลัก'
          });
      }
    } else {
      // กรณีไม่มี @mention เลย หรือโครงสร้าง mention ไม่ถูกต้อง
      console.log('--- Log: ไม่มี mention หรือโครงสร้าง mention ไม่ถูกต้อง ---');
      console.log('userMessage:', userMessage);
      // ตรวจสอบและ log event.message.mention
      if (event.message.mention === undefined) {
          console.log('event.message.mention is UNDEFINED');
      } else if (event.message.mention.mentionees === undefined) {
          console.log('event.message.mention.mentionees is UNDEFINED');
      } else {
          console.log('event.message.mention.mentionees.length is 0 or less');
      }
      console.log('Full event.message:', JSON.stringify(event.message, null, 2)); // log event.message เพื่อดูว่ามี mention field ไหม

      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'โปรด @mention คนที่ต้องการตั้งเป็นแอดมินหลักด้วยครับ (เช่น "ตั้ง @ชื่อสมาชิก")',
      });
    }
}

  // คำสั่ง: ตั้งรอง @<mention> (ตั้งแอดมินรอง)
  // เฉพาะแอดมินหลักเท่านั้นที่ตั้งแอดมินรองได้
  if (userMessage.startsWith('ตั้งรอง ')) {
    if (!mainAdmins.includes(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินหลักเท่านั้นที่ตั้งแอดมินรองได้ครับ',
      });
    }

    // ตรวจสอบว่ามีข้อมูล mention และมีสมาชิกที่ถูก mention จริงๆ
    if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
      const mentioneesUserId = event.message.mention.mentionees[0].userId;
      // ตรวจสอบรูปแบบคำสั่ง: "ตั้งรอง @<mention>"
      if (userMessage.startsWith('ตั้งรอง @')) {
          addSubAdmin(mentioneesUserId);
          return client.replyMessage(replyToken, {
            type: 'text',
            text: `ตั้งแอดมินรองเรียบร้อยแล้ว: `,
          });
      } else {
          // กรณีมี @mention แต่คำสั่งไม่ได้ขึ้นต้นด้วย "ตั้งรอง @" เป๊ะๆ
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'คำสั่งไม่ถูกต้องครับ ลองใช้ "ตั้งรอง @ชื่อสมาชิก" เพื่อตั้งแอดมินรอง'
          });
      }
    } else {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'โปรด @mention คนที่ต้องการตั้งเป็นแอดมินรองด้วยครับ (เช่น "ตั้งรอง @ชื่อสมาชิก")',
      });
    }
  }

  // --- คำสั่งจัดการบัญชีดำ (Blacklist) ---

  // คำสั่ง: แบน @<mention> (แบนผู้ใช้)
  // เฉพาะแอดมิน (หลักหรือรอง) เท่านั้นที่สามารถแบนได้
  if (userMessage.startsWith('แบน ')) {
      if (!isAdmin(senderUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "แบน" ได้ครับ'
          });
      }

      if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
          const mentioneesUserId = event.message.mention.mentionees[0].userId;
          addBlacklistedUser(mentioneesUserId);
          // พยายามดีดผู้ใช้ที่ถูกแบนออกจากกลุ่มทันที ถ้าอยู่ในกลุ่มนั้น
          if (event.source.type === 'group' || event.source.type === 'room') {
            try {
                await client.kickGroupMember(event.source.groupId || event.source.roomId, mentioneesUserId);
                return client.replyMessage(replyToken, {
                    type: 'text',
                    text: `ผู้ใช้ ${mentioneesUserId} ถูกแบนและถูกดีดออกจากกลุ่มแล้วครับ`
                });
            } catch (error) {
                console.error(`เกิดข้อผิดพลาดในการดีดผู้ใช้ที่ถูกแบน ${mentioneesUserId}:`, error);
                return client.replyMessage(replyToken, {
                    type: 'text',
                    text: `ผู้ใช้ ${mentioneesUserId} ถูกแบนแล้ว แต่ไม่สามารถดีดออกจากกลุ่มได้ (อาจไม่ได้อยู่ในกลุ่ม หรือเกิดข้อผิดพลาด)`
                });
            }
          }
          return client.replyMessage(replyToken, {
            type: 'text',
            text: `ผู้ใช้ ${mentioneesUserId} ถูกแบนเรียบร้อยแล้วครับ`,
          });
      } else {
          return client.replyMessage(replyToken, {
            type: 'text',
            text: 'โปรด @mention คนที่ต้องการแบนด้วยครับ (เช่น "แบน @ชื่อสมาชิก")',
          });
      }
  }

  // คำสั่ง: ล้างดำ (ล้างบัญชีดำทั้งหมด / ปลดแบนทุกคน)
  // เฉพาะแอดมิน (หลักหรือรอง) เท่านั้นที่ใช้คำสั่งนี้ได้
  if (userMessage === 'ล้างดำ') {
      if (!isAdmin(senderUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "ล้างดำ" ได้ครับ'
          });
      }
      blacklistedUsers.length = 0; // ล้างข้อมูลใน Array ให้ว่างเปล่า
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'รายชื่อผู้ถูกแบนทั้งหมดถูกล้างแล้วครับ ผู้ที่เคยถูกแบนสามารถเชิญกลับเข้ามาได้แล้ว',
      });
  }

  // คำสั่ง: ปลดแบน @<mention> (ปลดแบนผู้ใช้ที่ระบุ)
  // เฉพาะแอดมิน (หลักหรือรอง) เท่านั้นที่ใช้คำสั่งนี้ได้
  if (userMessage.startsWith('ปลดแบน ')) {
      if (!isAdmin(senderUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "ปลดแบน" ได้ครับ'
          });
      }
      if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
          const mentioneesUserId = event.message.mention.mentionees[0].userId;
          if (removeBlacklistedUser(mentioneesUserId)) {
              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: `ผู้ใช้ ${mentioneesUserId} ถูกปลดแบนเรียบร้อยแล้วครับ`
              });
          } else {
              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: `ผู้ใช้ ${mentioneesUserId} ไม่ได้อยู่ในรายชื่อผู้ถูกแบนครับ`
              });
          }
      } else {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'โปรด @mention คนที่ต้องการปลดแบนด้วยครับ (เช่น "ปลดแบน @ชื่อสมาชิก")'
          });
      }
  }

  // --- คำสั่งควบคุมการเชิญสมาชิก (Invitation Control) ---

  // คำสั่ง: เปิดเชิญ (อนุญาตให้เชิญสมาชิก)
  // เฉพาะแอดมิน (หลักหรือรอง) เท่านั้นที่ใช้คำสั่งนี้ได้
  if (userMessage === 'เปิดเชิญ') {
    if (!isAdmin(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "เปิดเชิญ" ได้ครับ',
      });
    }
    allowInvite = true;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: 'ตอนนี้อนุญาตให้เชิญคนเข้ากลุ่มได้ครับ',
    });
  }

  // คำสั่ง: ปิดเชิญ (ไม่อนุญาตให้เชิญสมาชิก)
  // เฉพาะแอดมิน (หลักหรือรอง) เท่านั้นที่ใช้คำสั่งนี้ได้
  if (userMessage === 'ปิดเชิญ') {
    if (!isAdmin(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "ปิดเชิญ" ได้ครับ',
      });
    }
    allowInvite = false;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: 'ปิดระบบเชิญแล้ว ห้ามเชิญคนเพิ่มอีกครับ',
    });
  }

  // --- คำสั่งทั่วไป (สำหรับแอดมินเท่านั้น) ---
  // คำสั่ง: รายชื่อแอดมิน
  if (userMessage === 'รายชื่อแอดมิน') {
    if (!isAdmin(senderUserId)) {
        return client.replyMessage(replyToken, {
            type: 'text',
            text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "รายชื่อแอดมิน" ได้ครับ'
        });
    }
    let responseText = '--- รายชื่อแอดมินและผู้ถูกแบน ---\n';
    responseText += `**แอดมินหลัก** (${mainAdmins.length} คน):\n`;
    if (mainAdmins.length > 0) {
        for (const adminId of mainAdmins) {
            // ในแอปพลิเคชันจริง อาจจะดึง Profile ของผู้ใช้มาแสดงชื่อแทน User ID
            responseText += `- ${adminId}\n`;
        }
    } else {
        responseText += '- ไม่มีแอดมินหลัก\n';
    }

    responseText += `**แอดมินรอง** (${subAdmins.length} คน):\n`;
    if (subAdmins.length > 0) {
        for (const adminId of subAdmins) {
            responseText += `- ${adminId}\n`;
        }
    } else {
        responseText += '- ไม่มีแอดมินรอง\n';
    }

    responseText += `**รายชื่อผู้ถูกแบน** (${blacklistedUsers.length} คน):\n`;
    if (blacklistedUsers.length > 0) {
        for (const bannedId of blacklistedUsers) {
            responseText += `- ${bannedId}\n`;
        }
    } else {
        responseText += '- ไม่มีผู้ถูกแบน\n';
    }

    return client.replyMessage(replyToken, {
        type: 'text',
        text: responseText
    });
  }

  // คำสั่ง: ลบแอด @<mention> (ลบตำแหน่งแอดมิน)
  if (userMessage.startsWith('ลบแอด ')) {
    // เฉพาะแอดมินหลักเท่านั้นที่สามารถลบตำแหน่งแอดมินคนอื่นได้
    if (!mainAdmins.includes(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินหลักเท่านั้นที่สามารถใช้คำสั่ง "ลบแอด" ได้ครับ',
      });
    }

    if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
      const mentioneesUserId = event.message.mention.mentionees[0].userId;
      if (removeAdmin(mentioneesUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: `ผู้ใช้ ${mentioneesUserId} ถูกลบออกจากตำแหน่งแอดมินแล้วครับ`
          });
      } else {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: `ผู้ใช้ ${mentioneesUserId} ไม่ใช่แอดมิน`
          });
      }
    } else {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'โปรด @mention คนที่ต้องการลบตำแหน่งแอดมินด้วยครับ (เช่น "ลบแอด @ชื่อสมาชิก")',
      });
    }
  }


  // คำสั่งสำรองสำหรับข้อความที่ไม่ตรงกับคำสั่งใดๆ
  // บอทจะตอบกลับข้อความที่ผู้ใช้พิมพ์มา
  return client.replyMessage(replyToken, {
    type: 'text',
    text: `คุณพิมพ์: "${userMessage}" (ยังไม่มีคำสั่งนี้ หรือคำสั่งไม่ถูกต้อง)`,
  });
}

// เริ่มต้น Express server
app.listen(port, () => {
  console.log(`LINE Bot กำลังทำงานบนพอร์ต ${port}`);
});