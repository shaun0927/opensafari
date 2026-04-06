# Device Preset Accuracy Table

OpenSafari defines 10 device presets with viewport dimensions and pixel ratios.
This table documents the verification status of each preset against real Xcode Simulator output.

Source: `src/simulator/presets.ts`

## Verification Method

Dimensions are verified using `xcrun simctl io <UDID> enumerate`, which reports the physical
pixel resolution of the simulator's LCD display (Display class 0). Logical dimensions are
calculated as `physical / DPR`. WebKit `window.innerWidth` / `window.devicePixelRatio` are
used as secondary verification where available.

## Accuracy Table

| Preset Key | Device | Width | Height | DPR | Physical | Status | Verified | Xcode | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `iphone-se-1` | iPhone SE (1st gen) | 320 | 568 | 2x | 640x1136 | :warning: Spec-only | 2026-04-06 | 26.4 | Incompatible with iOS 26.4 runtime; dimensions from Apple specs |
| `iphone-se-2` | iPhone SE (2nd gen) | 375 | 667 | 2x | 750x1334 | :white_check_mark: Match | 2026-04-06 | 26.4 | |
| `iphone-se-3` | iPhone SE (3rd gen) | 375 | 667 | 2x | 750x1334 | :white_check_mark: Match | 2026-04-06 | 26.4 | DPR corrected from 3 to 2 (was incorrect in v0.2.0) |
| `iphone-17e` | iPhone 17e | 390 | 844 | 3x | 1170x2532 | :white_check_mark: Match | 2026-04-06 | 26.4 | |
| `iphone-17` | iPhone 17 | 402 | 874 | 3x | 1206x2622 | :white_check_mark: Match | 2026-04-06 | 26.4 | |
| `iphone-air` | iPhone Air | 420 | 912 | 3x | 1260x2736 | :white_check_mark: Match | 2026-04-06 | 26.4 | |
| `iphone-17-pro` | iPhone 17 Pro | 402 | 874 | 3x | 1206x2622 | :white_check_mark: Match | 2026-04-06 | 26.4 | Also verified via WebKit JS (innerWidth=402, dpr=3) |
| `iphone-17-pro-max` | iPhone 17 Pro Max | 440 | 956 | 3x | 1320x2868 | :white_check_mark: Match | 2026-04-06 | 26.4 | |
| `ipad-air` | iPad Air 13-inch (M4) | 1024 | 1366 | 2x | 2048x2732 | :white_check_mark: Match | 2026-04-06 | 26.4 | |
| `ipad-pro` | iPad Pro 13-inch (M5) | 1032 | 1376 | 2x | 2064x2752 | :white_check_mark: Match | 2026-04-06 | 26.4 | |

## Known Caveats

- **iPhone SE (1st gen)**: Cannot be verified on iOS 26.4 as the device type is incompatible with this runtime. Dimensions are based on Apple's published specifications (640x1136 physical pixels, @2x).
- **`window.innerHeight`**: The Safari viewport height reported by `window.innerHeight` will be smaller than the preset height due to Safari's address bar and toolbar chrome. The preset `h` value represents the device's logical screen height, not the visible viewport area within Safari.
- **iPhone SE (3rd gen) DPR fix**: The DPR was incorrectly set to 3x in versions prior to this verification. The actual hardware uses a 750x1334 display at 326 PPI, which is @2x (same panel as iPhone SE 2nd gen and iPhone 8).

## Automated Verification

Run the verification script to re-check presets against your local Xcode Simulator:

```bash
npx ts-node scripts/verify-presets.ts
```

The script outputs a markdown table and reports PASS/FAIL per device with a +/-1 point tolerance for rounding.
