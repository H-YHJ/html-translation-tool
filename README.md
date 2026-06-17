# 上下文翻译助手

一个 Edge/Chrome 浏览器扩展原型，用来替代浏览器自带的粗糙网页翻译：它会先读取网页标题、语言、meta 描述、标题层级和段落位置，再把可见文本分批交给翻译模型处理。

## 现在能做什么

- 翻译当前网页的可见正文，并保留原网页 DOM 结构。
- 翻译页面选中文本，显示原文和译文浮层。
- 一键恢复原文。
- 自定义目标语言、模型、Chat Completions 接口和术语偏好。
- 只把译文写入文本节点，不把模型返回内容当作 HTML 注入页面。

## 使用方法

1. 打开 Edge 或 Chrome 的扩展管理页。
2. 开启“开发人员模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本目录：`C:\Users\亮壶\Documents\翻译助手`。
5. 修改代码后，在扩展管理页点击这个扩展的“重新加载”。
6. 点击浏览器工具栏里的拼图图标，把“上下文翻译助手”固定到工具栏。
7. 点击工具栏里的“上下文翻译助手”，填入 API 密钥后保存。
8. 在普通网页上点击“翻译页面”或先选中文字再点“翻译选中”。

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
- Custom OpenAI-compatible: manually fill endpoint and model

API 密钥不会写入项目文件，只保存在浏览器扩展的本地 storage 里。不要把 API 密钥提交到 GitHub。

如果使用其他服务商，需要它兼容 Chat Completions 请求和返回格式；如果域名不在 `manifest.json` 的 `host_permissions` 里，需要先把域名加入权限列表。

## 准确度设计

普通网页翻译常见问题是“逐句翻译”，它不知道页面主题、产品名、段落位置和术语习惯。这个原型的翻译链路是：

1. 读取页面上下文：标题、语言、URL、meta 描述、Open Graph 信息、H1-H3。
2. 读取可见文本节点，跳过代码、表单、脚本、SVG、隐藏内容。
3. 给每段文本附带标签名和所在 section/heading。
4. 分批发给模型，要求按上下文翻译并返回严格 JSON。
5. 只替换对应文本节点，保留原始空白和页面结构。

## 后续可以增强

- 自动提取术语表，并在翻译前让用户确认。
- 对页面进行双语对照，而不是直接替换。
- 给不确定译文标注原因，支持人工改写后记忆。
- 增加翻译缓存，重复页面不再重复请求。
- 支持 DeepL、Google、Ollama、本地大模型等 provider adapter。
- 针对字幕、PDF canvas、Shadow DOM 和动态 SPA 做专门适配。

## 协作约定

- 每次代码更新后都同步到 GitHub 远端 `origin/main`。
- 推送前先做基础检查：`manifest.json` 解析、关键 JS 语法检查、密钥扫描。
- API 密钥只保存在浏览器扩展本地 storage，不写入仓库文件。
