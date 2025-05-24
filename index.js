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

// สถานะการอนุญาตเชิญสมาชิกใหม่
let allowInvite = true; // ค่าเริ่มต้นคืออนุญาตให้เชิญได้
// สถานะการอนุญาตให้วางลิงก์
let allowLinks = true; // ค่าเริ่มต้นคืออนุญาตให้วางลิงก์ได้

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

// *** เพิ่มฟังก์ชันดึงโปรไฟล์ผู้ใช้ ***
async function getUserProfile(userId) {
    try {
        const profile = await client.getProfile(userId);
        return profile; // { displayName, pictureUrl, statusMessage }
    } catch (error) {
        console.error('Error fetching user profile for ID:', userId, error);
        return null;
    }
}

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
  // console.log('--- Start LINE Event Log ---'); // สามารถเปิดหรือปิดได้หลังแก้ปัญหา
  // console.log(JSON.stringify(event, null, 2)); // สามารถเปิดหรือปิดได้หลังแก้ปัญหา
  // console.log('--- End LINE Event Log ---'); // สามารถเปิดหรือปิดได้หลังแก้ปัญหา

  const groupId = event.source.groupId || event.source.roomId; // Group ID หรือ Room ID (ถ้ามี)
  const senderUserId = event.source.userId; // User ID ของผู้ส่งข้อความ

  // กรณีมีสมาชิกใหม่เข้าร่วมกลุ่ม (memberJoined)
  if (event.type === 'memberJoined') {
    const inviterId = event.source.userId; // User ID ของคนเชิญ (ถ้ามี)
    const newMembers = event.joined.members.map(member => member.userId);

    // ตรวจสอบว่ามีสมาชิกใหม่คนใดอยู่ในบัญชีดำหรือไม่
    if (blacklistedUsers.some(bannedId => newMembers.includes(bannedId))) {
        for (const bannedUserId of newMembers.filter(userId => blacklistedUsers.includes(userId))) {
            try {
                const profile = await getUserProfile(bannedUserId);
                const displayName = profile ? profile.displayName : bannedUserId;
                await client.kickGroupMember(groupId, bannedUserId);
                await client.pushMessage(groupId, {
                    type: 'text',
                    text: `ผู้ใช้ "${displayName}" ถูกแบนและถูกดีดออกจากกลุ่มแล้ว.`
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
    // *** ป้องกันการเชิญโดยสมาชิกทั่วไป และป้องกันการเข้าจากลิงก์/QR Code ***
    // ถ้าไม่อนุญาตให้เชิญ (allowInvite เป็น false)
    // และคนเชิญไม่ใช่แอดมิน (isAdmin(inviterId) เป็น false)
    // หรือไม่มี inviterId (มักเกิดจากการเข้าผ่านลิงก์/QR Code)
    else if (!allowInvite && !isAdmin(inviterId)) {
        // ดีดคนเชิญออก (หากเป็นคนเชิญจริงๆ และไม่ใช่สมาชิกใหม่ที่เพิ่งเข้ามาเอง)
        if (inviterId && !newMembers.includes(inviterId)) {
            try {
                const inviterProfile = await getUserProfile(inviterId);
                const inviterDisplayName = inviterProfile ? inviterProfile.displayName : inviterId;
                await client.kickGroupMember(groupId, inviterId);

                await client.pushMessage(groupId, {
                    type: 'text',
                    text: `สมาชิก "${inviterDisplayName}" ได้เชิญผู้อื่นเข้ามาในขณะที่ปิดระบบเชิญสมาชิกอยู่ จึงถูกดีดออกจากกลุ่ม`
                });
                console.log(`ดีดผู้ใช้ ${inviterId} ออกจากกลุ่ม ${groupId} เนื่องจากเชิญโดยไม่ได้รับอนุญาต`);
            } catch (error) {
                console.error('เกิดข้อผิดพลาดในการดีดคนเชิญ:', error);
                await client.pushMessage(groupId, {
                    type: 'text',
                    text: `ไม่สามารถดีดผู้ใช้ ${inviterId} ออกได้ (เกิดข้อผิดพลาดในการป้องกันการเชิญ)`
                });
            }
        }
        // ดีดสมาชิกใหม่ที่เข้ามาจากการใช้ลิงก์/QR Code (ไม่มี inviterId หรือ inviterId คือบอทเอง)
        // หรือกรณีที่คนเชิญไม่ใช่แอดมิน แต่เป็นสมาชิกใหม่ (บอทดีดคนเชิญไม่ได้ ก็ดีดสมาชิกใหม่แทน)
        for (const newMemberId of newMembers) {
             // ตรวจสอบว่าสมาชิกใหม่ไม่ได้ถูกเชิญโดยแอดมินที่ได้รับอนุญาต หรือเข้ามาโดยไม่มีคนเชิญ
            if (!inviterId || !isAdmin(inviterId)) { // ถ้าไม่มีคนเชิญ (ลิงก์/QR) หรือคนเชิญไม่ใช่แอดมิน
                try {
                    const newMemberProfile = await getUserProfile(newMemberId);
                    const newMemberDisplayName = newMemberProfile ? newMemberProfile.displayName : newMemberId;
                    await client.kickGroupMember(groupId, newMemberId);
                    await client.pushMessage(groupId, {
                        type: 'text',
                        text: `ผู้ใช้ "${newMemberDisplayName}" ถูกดีดออกจากกลุ่ม เนื่องจากมีการปิดการเข้ากลุ่มจากลิงก์/QR Code หรือเชิญโดยผู้ที่ไม่มีสิทธิ์`
                    });
                    console.log(`ดีดสมาชิกใหม่ ${newMemberId} ออกจากกลุ่ม ${groupId} เนื่องจากปิดการเชิญ/เข้าจากลิงก์`);
                } catch (error) {
                    console.error(`เกิดข้อผิดพลาดในการดีดสมาชิกใหม่ ${newMemberId}:`, error);
                    await client.pushMessage(groupId, {
                        type: 'text',
                        text: `ไม่สามารถดีดผู้ใช้ ${newMemberId} ออกได้ (เกิดข้อผิดพลาดในการป้องกันการเข้ากลุ่ม)`
                    });
                }
            }
        }
    }
    return null;
  }

  // ไม่สนใจเหตุการณ์ที่ไม่ใช่ข้อความ หรือไม่ใช่ข้อความแบบ Text
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userMessage = event.message.text.trim();
  const replyToken = event.replyToken;

  // *** ป้องกันการวางลิงก์สำหรับสมาชิกทั่วไป ***
  // ตรวจสอบว่าผู้ส่งข้อความไม่ใช่แอดมิน และ allowLinks เป็น false
  const urlRegex = /(https?:\/\/[^\s]+)/g; // Regular expression สำหรับตรวจจับ URL
  if (!isAdmin(senderUserId) && !allowLinks && urlRegex.test(userMessage)) {
    try {
        const senderProfile = await getUserProfile(senderUserId);
        const senderDisplayName = senderProfile ? senderProfile.displayName : senderUserId;
        await client.kickGroupMember(groupId, senderUserId);
        await client.pushMessage(groupId, {
            type: 'text',
            text: `สมาชิก "${senderDisplayName}" ถูกดีดออกจากกลุ่ม เนื่องจากวางลิงก์ในขณะที่ปิดระบบวางลิงก์อยู่`
        });
        console.log(`ดีดผู้ใช้ ${senderUserId} ออกจากกลุ่ม ${groupId} เนื่องจากวางลิงก์โดยไม่ได้รับอนุญาต`);
        return null; // ไม่ต้องประมวลผลข้อความนี้ต่อ
    } catch (error) {
        console.error('เกิดข้อผิดพลาดในการดีดผู้ใช้ออกเนื่องจากวางลิงก์:', error);
        await client.pushMessage(groupId, {
            type: 'text',
            text: `ไม่สามารถดีดผู้ใช้ ${senderUserId} ออกได้ (เกิดข้อผิดพลาดในการป้องกันการวางลิงก์)`
        });
        // ให้ประมวลผลข้อความต่อ เพื่อให้บอทไม่เงียบไปเฉยๆ
    }
  }


  // --- คำสั่งสำหรับจัดการแอดมิน ---

  // คำสั่ง: ตั้ง @<mention> (ตั้งแอดมินหลัก)
  if (userMessage.startsWith('ตั้ง ')) {
    if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
      const mentionedUserId = event.message.mention.mentionees[0].userId;

      if (userMessage.startsWith('ตั้ง @')) {
          if (mainAdmins.length === 0 || mainAdmins.includes(senderUserId)) {
              addMainAdmin(mentionedUserId);
              const profile = await getUserProfile(mentionedUserId);
              const displayName = profile ? profile.displayName : mentionedUserId;

              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: `ตั้งแอดมินหลักเรียบร้อยแล้ว: ${displayName}`
              });
          } else {
              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: 'เฉพาะแอดมินหลักเท่านั้นที่ตั้งแอดมินหลักได้ครับ'
              });
          }
      } else {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'คำสั่งไม่ถูกต้องครับ ลองใช้ "ตั้ง @ชื่อสมาชิก" เพื่อตั้งแอดมินหลัก'
          });
      }
    } else {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'โปรด @mention คนที่ต้องการตั้งเป็นแอดมินหลักด้วยครับ (เช่น "ตั้ง @ชื่อสมาชิก")',
      });
    }
  }

  // คำสั่ง: ตั้งรอง @<mention> (ตั้งแอดมินรอง)
  if (userMessage.startsWith('ตั้งรอง ')) {
    if (!mainAdmins.includes(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินหลักเท่านั้นที่ตั้งแอดมินรองได้ครับ',
      });
    }

    if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
      const mentionedUserId = event.message.mention.mentionees[0].userId;
      if (userMessage.startsWith('ตั้งรอง @')) {
          addSubAdmin(mentionedUserId);
          const profile = await getUserProfile(mentionedUserId);
          const displayName = profile ? profile.displayName : mentionedUserId;
          return client.replyMessage(replyToken, {
            type: 'text',
            text: `ตั้งแอดมินรองเรียบร้อยแล้ว: ${displayName}`,
          });
      } else {
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
  if (userMessage.startsWith('แบน ')) {
      if (!isAdmin(senderUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "แบน" ได้ครับ'
          });
      }

      if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
          const mentionedUserId = event.message.mention.mentionees[0].userId;
          addBlacklistedUser(mentionedUserId);
          const profile = await getUserProfile(mentionedUserId);
          const displayName = profile ? profile.displayName : mentionedUserId;

          if (event.source.type === 'group' || event.source.type === 'room') {
            try {
                await client.kickGroupMember(groupId, mentionedUserId);
                return client.replyMessage(replyToken, {
                    type: 'text',
                    text: `ผู้ใช้ "${displayName}" ถูกแบนและถูกดีดออกจากกลุ่มแล้วครับ`
                });
            } catch (error) {
                console.error(`เกิดข้อผิดพลาดในการดีดผู้ใช้ที่ถูกแบน ${mentionedUserId}:`, error);
                return client.replyMessage(replyToken, {
                    type: 'text',
                    text: `ผู้ใช้ "${displayName}" ถูกแบนแล้ว แต่ไม่สามารถดีดออกจากกลุ่มได้ (อาจไม่ได้อยู่ในกลุ่ม หรือเกิดข้อผิดพลาด)`
                });
            }
          }
          return client.replyMessage(replyToken, {
            type: 'text',
            text: `ผู้ใช้ "${displayName}" ถูกแบนเรียบร้อยแล้วครับ`,
          });
      } else {
          return client.replyMessage(replyToken, {
            type: 'text',
            text: 'โปรด @mention คนที่ต้องการแบนด้วยครับ (เช่น "แบน @ชื่อสมาชิก")',
          });
      }
  }

  // คำสั่ง: ล้างดำ (ล้างบัญชีดำทั้งหมด / ปลดแบนทุกคน)
  if (userMessage === 'ล้างดำ') {
      if (!isAdmin(senderUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "ล้างดำ" ได้ครับ'
          });
      }
      blacklistedUsers.length = 0;
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'รายชื่อผู้ถูกแบนทั้งหมดถูกล้างแล้วครับ ผู้ที่เคยถูกแบนสามารถเชิญกลับเข้ามาได้แล้ว',
      });
  }

  // คำสั่ง: ปลดแบน @<mention> (ปลดแบนผู้ใช้ที่ระบุ)
  if (userMessage.startsWith('ปลดแบน ')) {
      if (!isAdmin(senderUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "ปลดแบน" ได้ครับ'
          });
      }
      if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
          const mentionedUserId = event.message.mention.mentionees[0].userId;
          const profile = await getUserProfile(mentionedUserId);
          const displayName = profile ? profile.displayName : mentionedUserId;

          if (removeBlacklistedUser(mentionedUserId)) {
              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: `ผู้ใช้ "${displayName}" ถูกปลดแบนเรียบร้อยแล้วครับ`
              });
          } else {
              return client.replyMessage(replyToken, {
                  type: 'text',
                  text: `ผู้ใช้ "${displayName}" ไม่ได้อยู่ในรายชื่อผู้ถูกแบนครับ`
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

  // --- คำสั่งควบคุมการวางลิงก์ ---

  // คำสั่ง: เปิดลิงก์ (อนุญาตให้วางลิงก์ได้)
  if (userMessage === 'เปิดลิงก์') {
    if (!isAdmin(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "เปิดลิงก์" ได้ครับ',
      });
    }
    allowLinks = true;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: 'ตอนนี้อนุญาตให้สมาชิกทั่วไปวางลิงก์ได้ครับ',
    });
  }

  // คำสั่ง: ปิดลิงก์ (ไม่อนุญาตให้สมาชิกทั่วไปวางลิงก์)
  if (userMessage === 'ปิดลิงก์') {
    if (!isAdmin(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินเท่านั้นที่สามารถใช้คำสั่ง "ปิดลิงก์" ได้ครับ',
      });
    }
    allowLinks = false;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: 'ปิดระบบวางลิงก์แล้ว ห้ามสมาชิกทั่วไปวางลิงก์ครับ',
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

    // ดึงชื่อแอดมินหลัก
    responseText += `**แอดมินหลัก** (${mainAdmins.length} คน):\n`;
    if (mainAdmins.length > 0) {
        for (const adminId of mainAdmins) {
            const profile = await getUserProfile(adminId);
            const displayName = profile ? profile.displayName : adminId;
            responseText += `- ${displayName} (ID: ${adminId})\n`;
        }
    } else {
        responseText += '- ไม่มีแอดมินหลัก\n';
    }

    // ดึงชื่อแอดมินรอง
    responseText += `**แอดมินรอง** (${subAdmins.length} คน):\n`;
    if (subAdmins.length > 0) {
        for (const adminId of subAdmins) {
            const profile = await getUserProfile(adminId);
            const displayName = profile ? profile.displayName : adminId;
            responseText += `- ${displayName} (ID: ${adminId})\n`;
        }
    } else {
        responseText += '- ไม่มีแอดมินรอง\n';
    }

    // ดึงชื่อผู้ถูกแบน
    responseText += `**รายชื่อผู้ถูกแบน** (${blacklistedUsers.length} คน):\n`;
    if (blacklistedUsers.length > 0) {
        for (const bannedId of blacklistedUsers) {
            const profile = await getUserProfile(bannedId);
            const displayName = profile ? profile.displayName : bannedId;
            responseText += `- ${displayName} (ID: ${bannedId})\n`;
        }
    } else {
        responseText += '- ไม่มีผู้ถูกแบน\n';
    }

    // แสดงสถานะการตั้งค่าปัจจุบัน
    responseText += `\n--- สถานะการตั้งค่า ---\n`;
    responseText += `อนุญาตให้เชิญสมาชิก: ${allowInvite ? 'เปิด' : 'ปิด'}\n`;
    responseText += `อนุญาตให้วางลิงก์: ${allowLinks ? 'เปิด' : 'ปิด'}\n`;


    return client.replyMessage(replyToken, {
        type: 'text',
        text: responseText
    });
  }

  // คำสั่ง: ลบแอด @<mention> (ลบตำแหน่งแอดมิน)
  if (userMessage.startsWith('ลบแอด ')) {
    if (!mainAdmins.includes(senderUserId)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: 'เฉพาะแอดมินหลักเท่านั้นที่สามารถใช้คำสั่ง "ลบแอด" ได้ครับ',
      });
    }

    if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
      const mentionedUserId = event.message.mention.mentionees[0].userId;
      const profile = await getUserProfile(mentionedUserId);
      const displayName = profile ? profile.displayName : mentionedUserId;

      if (removeAdmin(mentionedUserId)) {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: `ผู้ใช้ "${displayName}" ถูกลบออกจากตำแหน่งแอดมินแล้วครับ`
          });
      } else {
          return client.replyMessage(replyToken, {
              type: 'text',
              text: `ผู้ใช้ "${displayName}" ไม่ใช่แอดมิน`
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
  return client.replyMessage(replyToken, {
    type: 'text',
    text: `คุณพิมพ์: "${userMessage}" (ยังไม่มีคำสั่งนี้ หรือคำสั่งไม่ถูกต้อง)`,
  });
}

// เริ่มต้น Express server
app.listen(port, () => {
  console.log(`LINE Bot กำลังทำงานบนพอร์ต ${port}`);
});