import { Markup } from 'telegraf';

export function getMainKeyboard() {
  return Markup.keyboard([
    ['📥 تحميل فيديو', '📧 إيميل مؤقت'],
    ['📱 رقم وهمي', '🧠 اسأل الذكاء'],
    ['🎨 اسم مزخرف', '🖼️ فلتر صور'],
    ['ℹ️ المساعدة'],
  ]).resize();
}
