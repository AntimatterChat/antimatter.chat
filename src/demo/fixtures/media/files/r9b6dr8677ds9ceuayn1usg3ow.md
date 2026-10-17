# Lumen OS 2.4.0-rc3

## Highlights
- Standby power 318 mW on the Arc (was 455 mW on rc1)
- Delta OTA updates for the Arc and the Dial
- Faster Thread rejoin after border router reboots

## Fixes
- OTA: persist the rollback flag before the swap
- Dial: smoother rotation acceleration
- Zephyr 3.6.1 security fixes

## Known issues
- Dial battery level may read 100% until the next charge cycle
