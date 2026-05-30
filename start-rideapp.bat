@echo off
echo Starting RideApp...
start cmd /k "cd C:\Users\Dn\rideapp-backend && npm run dev"
timeout /t 3
start cmd /k "cd C:\Users\Dn\rideapp-mobile3 && npx expo start --clear"
echo Done!