# 数字人模型目录

当前仓库内置 **Kei** 示例模型与三个运行时（合计约 2 MB），`model.manifest.json` 里 `"model": "kei"`，App 启动即走 L1 Live2D。规格见 `docs/dev.md` §2.3.1。

## 里面是什么

```
live2d/
├── model.manifest.json            # 清单：模型路径、缩放、口型参数、动作组
├── vendor/                        # 三个运行时，顺序固定（清单 runtime 已写好）
│   ├── live2dcubismcore.min.js    # Cubism Core，Live2D 官方 CDN
│   ├── pixi.min.js                # pixi.js 6.5.10
│   └── cubism4.min.js             # pixi-live2d-display 0.4.0（Cubism 3/4 包）
└── kei/                           # Kei 示例模型（裁过的最小集合）
    ├── kei_basic_free.model3.json # 动作组已重写为 Idle / TapBody
    ├── kei_basic_free.moc3
    ├── kei_basic_free.physics3.json
    ├── kei_basic_free.cdi3.json
    ├── kei_basic_free.2048/texture_00.png
    └── motions/                   # 01_kei_zh（Idle）、01_kei_en（TapBody）
```

原始下载包 `web/public/kei_zh-Hans/`（36 MB，含 `kei_vowels_pro` 与两个模型各 13 MB 的语音 wav）**不提交**：`model3.json` 里动作组名是空串，且语音会跟 App 的 TTS 抢喇叭。`kei/` 是从中裁出的可跑子集，删掉了 `Sound` / `MotionSync` 引用。

## 换一个模型（不改代码）

1. **运行时** → `vendor/`（已就位；换版本时保持顺序）
   - `live2dcubismcore.min.js`：Cubism Core，从 Live2D 官网 Cubism SDK for Web 下载（**专有许可**，不得进 npm 依赖）
   - `pixi.min.js`：pixi.js **6.x**
   - `cubism4.min.js`：pixi-live2d-display **0.4.x** 的 Cubism 3/4 包
2. **模型** → `<模型目录>/`：`.model3.json`、`.moc3`、`textures/*.png`（≤2048px）、`motions/` 至少含 `Idle` 与 `TapBody` 两组。只支持 Cubism 3/4/5（`.moc3`），不支持 Cubism 2（`.moc`）。
3. **改清单三行**：`model`、`modelPath`；参数名不同再改 `params.mouthOpen`（口型）/ `params.angleX`（朝向），动作组名不同改 `motionGroups`。缺参数不会报错，只是少了对应动效。
4. 体积：运行时 + 模型整目录 ≤ 8 MB（当前 2.0 MB）。
5. `npm run build && npx cap sync android`（Android 包内资源要重新打包）。

## 关掉 Live2D

把清单改成 `"model": null` 即可：只请求这一份 <1KB 的清单，不下载任何脚本，界面回到 Canvas-2D（规格 §2.3.1 ⑤ 的 L2）。

## 降级（自动，无需配置）

| 情况 | 结果 |
|---|---|
| `model` 为 `null`、清单缺失或格式不对 | L2 Canvas-2D |
| 运行时 / 模型加载失败、WebGL 不可用、3 秒未加载完 | L2 Canvas-2D |
| 2D 画布也不可用 | L3 静态头像 |

三级都可以单击（重说上一句）和长按 1 秒（开始聆听）。

## 许可

Kei 是 Live2D 官方示例素材（`kei_zh-Hans/ReadMe.txt` 随包）：

> 个人及小规模企业在同意授权协议后可用于商业用途；中/大规模企业只能用于非公开内部试用。

- 来源：https://www.live2d.com/zh-CHS/download/sample-data/
- 模型与插画：Live2D Inc.
- 授权协议：https://www.live2d.com/eula/live2d-sample-model-license-agreement_cn.html
- 答辩/演示时注明「Live2D 官方示例模型 Kei」

| 文件 | 来源 | 许可 |
|---|---|---|
| `kei/` | Live2D 官方示例素材（Kei） | 见上，示例模型授权 |
| `vendor/live2dcubismcore.min.js` | Live2D Cubism SDK for Web | Live2D 专有许可 |
| `vendor/pixi.min.js` | pixi.js 6.5.10 | MIT |
| `vendor/cubism4.min.js` | pixi-live2d-display 0.4.0 | MIT |

## 自检

```bash
cd web
for f in vendor/live2dcubismcore.min.js vendor/pixi.min.js vendor/cubism4.min.js kei/kei_basic_free.model3.json; do
  test -f "public/live2d/$f" || { echo "MISSING $f"; exit 1; }
done
node src/selfcheck.ts   # 含 parseManifest 降级与 kei 清单断言
```
