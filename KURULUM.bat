@echo off
echo ========================================
echo   Guliz Transfer - Kurulum Basliyor
echo ========================================
echo.

echo [1/4] npm paketleri yukleniyor...
call npm install
if errorlevel 1 goto hata

echo.
echo [2/4] .env dosyasi olusturuluyor...
if not exist .env (
  copy .env.example .env
  echo .env dosyasi olusturuldu.
  echo LUTFEN .env dosyasini acip DB_PASSWORD alanina PostgreSQL sifrenizi yazin!
  notepad .env
  pause
) else (
  echo .env zaten mevcut, atlanıyor.
)

echo.
echo [3/4] Veritabani tablolari olusturuluyor...
call node models/migrate.js
if errorlevel 1 goto hata

echo.
echo [4/4] Sunucu baslatiliyor...
echo.
echo ==========================================
echo  Musteri sitesi : http://localhost:3001/guliz-transfer.html
echo  Admin paneli   : http://localhost:3001/admin.html
echo  Admin giris    : admin@guliztransfer.com / Guliz2025!
echo ==========================================
echo.
call npm run dev
goto son

:hata
echo.
echo HATA olustu! Yukaridaki mesaji kontrol edin.
pause

:son
