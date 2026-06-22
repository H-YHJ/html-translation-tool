# 上下文翻译助手

一个 Edge/Chrome 浏览器扩展原型，用来替代浏览器自带的粗糙网页翻译：它会先读取网页标题、语言、meta 描述、标题层级和段落位置，再把可见文本分批交给翻译模型处理。

## 现在能做什么

- 翻译当前网页的可见正文，并保留原网页 DOM 结构。
- 翻译页面选中文本，显示原文、译文和备注浮层。
- 选中文字后显示页面内浮动翻译按钮，也可以用右键菜单翻译。
- 划词翻译后保留原文位置高亮，点击网页后也能继续定位刚才翻译的文字。
- 一键恢复原文。
- 自定义目标语言、模型、Chat Completions 接口、术语偏好和缓存开关。
- 支持速度模式：极速会跳过后台摘要/术语预处理并扩大批量；精准会保留更多上下文并增加批量重试。
- 支持免费翻译引擎：Chrome 内置翻译和 LibreTranslate 本地服务。
- 支持翻译风格模板：通用自然、技术文档、正式商务、自然口语、学术论文、产品介绍。
- 长页面或技术页面会按需在后台提取页面摘要和术语表，短页面直接翻译以减少等待。
- 对翻译结果做本地缓存，重复段落不再重复请求。
- 批量翻译失败时会重试；如果模型返回的 JSON 条数不对，会自动降级为逐条补译。
- 支持 OpenRouter 模型列表刷新，不必手动记模型 ID。
- 网页内翻译提示带进度条：整页翻译显示批次进度，语言包下载显示百分比。
- 内置海洋蓝 `T + 思考气泡` 扩展图标，已经配置工具栏和弹窗入口图标。
- 只把译文写入文本节点，不把模型返回内容当作 HTML 注入页面。

## 使用方法

1. 打开 Edge 或 Chrome 的扩展管理页。
2. 开启“开发人员模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本目录：`C:\Users\亮壶\Documents\翻译助手`。
5. 修改代码后，在扩展管理页点击这个扩展的“重新加载”。
6. 点击浏览器工具栏里的拼图图标，把“上下文翻译助手”固定到工具栏。
7. 点击工具栏里的“上下文翻译助手”，填入 API 密钥后保存。
8. 在普通网页上点击“翻译页面”，或直接选中文字后点击页面里的“译”按钮。
9. 也可以选中文字后右键，选择“用上下文翻译助手翻译”。

## 没有弹窗时

- 先去 `edge://extensions` 或 `chrome://extensions`，确认扩展没有显示红色错误。
- 修改本目录文件后，必须在扩展管理页点一次“重新加载”。
- 如果工具栏没有图标，点拼图图标，把“上下文翻译助手”固定出来。
- 如果当前页面是 `edge://`、`chrome://`、扩展商店、新标签页、PDF 查看器或浏览器设置页，扩展脚本不能运行；换一个普通 `https://` 网页再试。
- 如果工具栏 popup 还是打不开，可以在扩展详情页点“扩展选项”，这个项目已经把同一个设置页挂到了 options 页面。

弹窗里已经内置了几个 OpenAI 兼容 provider 预设：

- Auto：根据任务特征和已保存密钥，在已连接服务中选择更适合的模型。
- DeepSeek: `https://api.deepseek.com/chat/completions`, default model `deepseek-v4-pro`
- Alibaba Cloud Bailian: `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`, default model `qwen3.6-plus`
- OpenAI: `https://api.openai.com/v1/chat/completions`, default model `gpt-4.1-mini`
- OpenRouter: `https://openrouter.ai/api/v1/chat/completions`, default model `openai/gpt-4o-mini`
- Chrome 内置翻译：不需要 API key；Chrome 支持时会在极速模式优先尝试。
- LibreTranslate 本地：默认 `http://127.0.0.1:5000/translate`，本地服务通常不需要 API key。
- Custom OpenAI-compatible: manually fill endpoint and model

API 密钥不会写入项目文件，只保存在浏览器扩展的本地 storage 里。不要把 API 密钥提交到 GitHub。

如果使用其他服务商，需要它兼容 Chat Completions 请求和返回格式；如果域名不在 `manifest.json` 的 `host_permissions` 里，需要先把域名加入权限列表。

## 准确度设计

普通网页翻译常见问题是“逐句翻译”，它不知道页面主题、产品名、段落位置和术语习惯。这个原型的翻译链路是：

1. 读取页面上下文：标题、语言、URL、meta 描述、Open Graph 信息、H1-H3、正文文本样本。
2. 只在长页面、技术/产品页面等需要消歧时，让模型在后台生成页面摘要、领域判断、术语表和不确定项。
3. 把自动术语表和手动术语偏好合并进翻译提示词。
4. 读取可见文本节点，跳过代码、表单、脚本、SVG、隐藏内容和已经翻译过的节点。
5. 给每段文本附带标签名和所在 section/heading。
6. 分批发给模型，携带压缩后的上下文、术语表、速度模式和翻译风格，要求返回严格 JSON。
7. 优先命中本地缓存；缓存 key 保留站点、标题、section 和术语，不把大段正文样本塞进去，提升复用率。
8. 如果批量返回格式不完整，会根据速度模式决定是否重试和逐条补译；极速更少补译，精准更稳。
9. 通过网页内进度条展示读取、分析、批次翻译和 Chrome 语言包下载状态。
10. 直接替换对应文本节点，保留原始空白和页面结构。
11. 划词翻译会复制原选区位置为浅蓝高亮，方便用户在弹窗关闭或点击网页后继续定位。
12. 如果模型标记不确定译文，会插入一个小问号提示。

## 参考过的项目

- [Read Frog](https://github.com/mengxi-ream/read-frog)：参考了上下文提取、批处理和缓存的产品思路。
- [FluentRead](https://github.com/Bistutu/FluentRead)：参考了多 provider 配置和沉浸式阅读体验。
- [XTranslate](https://github.com/ixrock/XTranslate)：参考了浏览器扩展的入口设计，如划词、右键和页面动作。
- [context-based-translator](https://github.com/rfeng550/context-based-translator)：参考了 OpenRouter、划词浮层和解释备注的方向。

当前实现没有直接搬入这些项目的大型框架代码，而是把适合这个轻量 MV3 原型的做法重写成小模块。

## 差异化方向

- 更强调“网页级语境”而不是单句翻译：页面标题、meta、正文样本、section 标签都会进入提示词。
- 做轻量可读的纯扩展原型：不引入 React/Vue/WXT 构建链，方便快速改、快速装。
- 提供 Auto provider 选择：根据目标语言、文本量、技术语境和已保存密钥自动选服务。
- 面向术语一致性：保留术语偏好，网页自动术语表会静默参与 prompt，减少阅读打扰。
- 面向译后编辑：后续可以让用户改写某个译文，并把“原文 -> 用户译文”记入本地偏好。
- 面向可信翻译：后续可以让模型给“不确定术语”返回原因，但默认只在划词面板里展示，避免打扰整页阅读。

## 后续可以增强

- 支持用户修订译文后的本地记忆。
- 支持 Google、Ollama、本地大模型等 provider adapter。
- 针对字幕、PDF canvas 和 Shadow DOM 做专门适配。

## 协作约定

- 每次代码更新后都同步到 GitHub 远端 `origin/main`。
- 推送前先做基础检查：`manifest.json` 解析、关键 JS 语法检查、密钥扫描。
- API 密钥只保存在浏览器扩展本地 storage，不写入仓库文件。
