import os
import logging
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)
import yt_dlp

# Telegram Bot Token
TELEGRAM_BOT_TOKEN = "8984099997:AAHGqaTrG0tNTQUdFDGPcH8d_AenaF6pSwk"

# Logging Setup
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# Command: /start
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = (
        "👋 Welcome to TikTok Downloader Bot!\n\n"
        "📥 Send me any TikTok video link, and I will download it for you."
    )
    await update.message.reply_text(message)

# Handle TikTok Links
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return

    user_text = update.message.text.strip()
    
    if "tiktok.com" not in user_text:
        await update.message.reply_text("❌ Please send a valid TikTok link.")
        return

    status_message = await update.message.reply_text("⏳ Downloading video, please wait...")

    output_filename = "tiktok_video.mp4"

    ydl_opts = {
        'outtmpl': output_filename,
        'format': 'b',
        'overwrites': True,
        'quiet': True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([user_text])

        if os.path.exists(output_filename):
            with open(output_filename, 'rb') as video_file:
                await update.message.reply_video(video=video_file, caption="✅ Video downloaded successfully!")
            
            os.remove(output_filename)
            await status_message.delete()
        else:
            await status_message.edit_text("❌ Failed to process the video file.")

    except Exception as error:
        logger.error("Download Error: %s", error)
        await status_message.edit_text("❌ Failed to download video. Please ensure the link is public and valid.")

# Main Execution
def main():
    print("🤖 TikTok Downloader Bot is running...")

    app = (
        ApplicationBuilder()
        .token(TELEGRAM_BOT_TOKEN)
        .build()
    )

    app.add_handler(CommandHandler("start", start))
    app.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            handle_message
        )
    )

    app.run_polling()

if __name__ == "__main__":
    main()
