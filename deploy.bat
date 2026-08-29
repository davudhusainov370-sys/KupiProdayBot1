@echo off
REM ============================================================
REM  Скрипт деплоя проекта Market в GitHub.
REM  Запускать на СВОЁМ компьютере (где есть интернет и git).
REM ============================================================
REM 1) СОЗДАЙТЕ пустой репозиторий на https://github.com/new
REM    и вставьте его URL в строку ниже (замените ВАШ_ЛОГИН):
set REMOTE=https://github.com/davudhusainov370-sys/KupiProdayBot.git

REM 2) Если git ещё не настроен, выполните один раз:
REM    git config --global user.email "you@example.com"
REM    git config --global user.name "Your Name"

cd /d "%~dp0"
git init
git add .
git commit -m "Market mini app"
git branch -M main
git remote set-url origin %REMOTE% 2>nul || git remote add origin %REMOTE%
git push -u origin main --force

echo.
echo ============================================================
echo  Репозиторий залит! Дальше:
echo  1. render.com -> New -> Blueprint -> подключите репозиторий
echo  2. в поле BOT_TOKEN вставьте токен из @BotFather (/newbot)
echo  3. Deploy -> получите URL вида https://market-app.onrender.com
echo  4. @BotFather -> /setmenubutton -> вставьте этот URL
echo ============================================================
pause
