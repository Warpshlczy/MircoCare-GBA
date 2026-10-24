# 数字人模型目录（默认留空）

本目录**默认不带任何模型或运行时**。`model.manifest.json` 里 `"model": null` 时，App 只读这一份清单，然后直接用内置的 Canvas-2D 数字人（L2）。规格见 `docs/dev.md` §2.3.1。

## 接入一个模型（不改代码）

1. **运行时** → `vendor/`（三个文件，顺序固定，清单 `runtime` 字段已写好）
   - `live2dcubismcore.min.js`：Cubism Core，从 Live2D 官网 Cubism SDK for Web 下载（**专有许可**，不得进 npm 依赖）
   - `pixi.min.js`：pixi.js **6.x**
   - `cubism4.min.js`：pixi-live2d-display **0.4.x** 的 Cubism 3/4 包（`dist/cubism4.min.js`）
2. **模型** → `<模型目录>/`：`<name>.model3.json`、`<name>.moc3`、`textures/*.png`（≤2048px）、`motions/` 至少含 `Idle` 与 `TapBody` 两组。只支持 Cubism 3/4（`.moc3`），不支持 Cubism 2（`.moc`）。
3. **改清单两行**：
   ```json
   "model": "<模型目录>",
   "modelPath": "/live2d/<模型目录>/<name>.model3.json",
   ```
   参数名不同就改 `params.mouthOpen`（口型）/ `params.angleX`（朝向）；动作组名不同就改 `motionGroups`。缺参数不会报错，只是少了对应动效。
4. `npm run build && npx cap sync android`（Android 包内资源要重新打包）。

体积上限：运行时 + 模型整目录 ≤ 8 MB。

## 降级（自动，无需配置）

| 情况 | 结果 |
|---|---|
| `model` 为 `null`、清单缺失或格式不对 | L2 Canvas-2D（默认） |
| 运行时 / 模型加载失败、WebGL 不可用、3 秒未加载完 | L2 Canvas-2D |
| 2D 画布也不可用 | L3 静态头像 |

三级都可以单击（重说上一句）和长按 1 秒（开始聆听）。

## 许可

官方 sample 模型（Hiyori、Haru 等）**仅限非商用演示**；商用必须换成自有或已授权模型，并在本文件下方写明来源与许可。答辩时注明「演示用 sample 模型」。

| 文件 | 来源 | 许可 |
|---|---|---|
| （暂无） | | |

## 自检

```bash
cd web
test -z "$(find public/live2d \( -name '*.moc3' -o -name '*.model3.json' -o -name '*.min.js' \))" && echo "PASS: 模型留空"
node src/selfcheck.ts   # 含 parseManifest 降级断言
```
