# 前端库调研记录

日期：2026-06-17

## 结论

当前项目是无构建链的 Manifest V3 浏览器扩展 popup。ReactBits、assistant-ui、shadcn/ui、21st.dev、Ant Design X 和 HeroUI 都偏 React/Tailwind/npm 生态；直接引入会让扩展从轻量静态文件变成需要打包的 React 应用。

本轮采用“吸收组件模式和视觉语言，不引入运行时依赖”的方案：

- ReactBits: 借鉴轻微动效，用 `surface-in` 入场动画和按钮 hover/active 状态增强反馈。
- assistant-ui: 借鉴 AI 工具控制台的信息组织，保留服务、目标语言、密钥、模型、接口、术语偏好这些 AI 调用要素。
- shadcn/ui: 借鉴可组合、可定制、开放代码的组件思路，把按钮、输入框、选择器、面板样式抽成稳定 CSS 类。
- 21st.dev: 借鉴模板库的“完整小场景”思路，把 popup 做成设置控制台而不是零散表单。
- Ant Design X Markdown: 记录为后续“翻译解释/术语说明/流式结果渲染”的方向；当前 popup 暂不需要 Markdown 渲染器。
- HeroUI: 借鉴苹果风格、柔和默认视觉、按钮图标态、玻璃质感和一致组件状态。

## 已落地

- 新 logo：皇家海洋蓝“语境窗口”扩展图标，用双行文本的颜色转换表达上下文翻译，并同步到 toolbar、popup 和项目文档。
- 苹果风格视觉：柔和背景、玻璃面板、细腻阴影、蓝绿辅助色。
- 按钮组件：主要/次要按钮、图标按钮、hover/active/disabled 状态。
- API 密钥显示按钮：文字按钮替换为眼睛/隐藏眼睛图标。
- 表单组件：选择器、输入框、文本域、密钥输入组合。
- 网页内提示：toast 和选中文本浮层同步改为玻璃质感，并加入翻译进度条。
- 划词定位：翻译选中文本后保留浅蓝高亮，点击网页后仍能定位原文位置。

## 后续可升级

如果后面需要聊天式翻译解释、流式输出、Markdown 公式/代码块渲染，可以考虑把 popup 升级为 React + Vite 扩展构建链，再引入 assistant-ui、Ant Design X Markdown 或 shadcn/ui。
