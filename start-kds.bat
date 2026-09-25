@echo off
setlocal EnableDelayedExpansion
cd /d %~dp0

echo === KDS Auto Start ===
echo.

:: 1. Do IP LAN hien tai (uu tien 192.168.*, roi den 10.*)
set LANIP=
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do (
  set ip=%%a
  set ip=!ip: =!
  echo !ip! | findstr /b "192\.168\." >nul && if not defined LANIP set LANIP=!ip!
)
if not defined LANIP (
  for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do (
    set ip=%%a
    set ip=!ip: =!
    echo !ip! | findstr /b "10\." >nul && if not defined LANIP set LANIP=!ip!
  )
)
if not defined LANIP (
  echo [LOI] Khong tim thay IP LAN. Kiem tra lai Wi-Fi.
  pause
  exit /b 1
)

:: 2. Tu sua VITE_KDS_URL theo IP moi
echo VITE_KDS_URL=http://!LANIP!:3000> kds-client\.env
echo [OK] IP LAN: !LANIP!
echo [OK] Da cap nhat kds-client\.env -^> VITE_KDS_URL=http://!LANIP!:3000
echo.

:: 3. Mo 2 cua so cmd rieng: server + client
start "KDS Server" cmd /k "cd /d %~dp0kiotviet-server && npm start"
start "KDS Client" cmd /k "cd /d %~dp0kds-client && npm run dev"

echo [OK] Da mo 2 cua so: KDS Server (:3000) va KDS Client (:5173)
echo.
echo  - Quan ly server (may tinh): http://localhost:3000
echo  - Bep (may tinh):             http://localhost:5173
echo  - Bep (dien thoai cung Wi-Fi): http://!LANIP!:5173
echo.
pause
