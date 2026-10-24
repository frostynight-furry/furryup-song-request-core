# FurryUP Song Request Core

[English](README.en.md) · MIT · **0.1.0 预览版**

从 FurryUP Studio 拆出的 Node.js 点歌引擎：解析弹幕指令、匹配歌名与歌手、串行排队、取消、同曲换源、下一首预检与阶段诊断。无需 Electron，无运行时 npm 依赖。

本仓库提供机制和适配接口。它不连接直播平台，不包含 QQ / 网易云 / 汽水登录或搜索服务，也不提供真实音频播放器。演示中的音乐服务和播放完成信号都是合成数据。**真实直播连续点歌、完整歌曲播放、账号权益和 OBS 收音尚未通过本项目验收。**

## 运行

需要 Node.js 22.12 或更新版本。下载本仓库后，无需安装依赖：

```sh
node scripts/verify.cjs
node examples/replay.cjs
```

演示处理 `点歌+示例旋律+示例乐队`，匹配到 `示例旋律（Live）`，打印请求历史；不会联网或发出声音。`private: true` 用来避免误发 npm，不限制 MIT 授权或从 GitHub 使用源码。

## 接入

```js
const { SongRequests, defaults } = require('./core/index.cjs');

// backend 和 providers 由宿主实现，具体契约见 docs/ADAPTERS.md。
const engine = new SongRequests({ directory: './song-data', backend, providers });
engine.configure({ ...defaults(), enabled: true, musicProvider: 'auto' });
engine.on('change', () => render(engine.snapshot()));

await engine.accept({
  platform: 'bilibili', room_id: 'demo-room', user_id: 'demo-viewer',
  user_name: '示例观众', event_id: 'unique-event-id',
  event_type: 'comment', content: '点歌+示例旋律+示例乐队'
});
// 宿主退出时：await engine.dispose();
```

默认点歌关闭，需要显式启用。支持 `点歌 歌名 歌手`、`点歌+歌名+歌手`；自定义格式必须且只能有一个 `{song}`。匹配支持官方别名及省略单一 Live 后缀，仍校验歌手，并拒绝歧义、错误版本与错误歌手。

## 首版范围

- 支持四种规范化平台标识：`bilibili`、`douyin`、`kuaishou`、`wechat`；它们是事件字段，不代表附带四个平台的采集器。
- 音源标识为 `local`、`netease`、`qq`、`qishui`；`auto` 搜索宿主标记为已配置的来源。平台名称不代表该服务已经接入。
- 顺序准入、歌曲去重、同观众冷却、按平台/房间/观众隔离的礼物资格、撤回自己的最新待播请求。
- 暂停、跳过、清空、紧急停止、失败换源与继续下一首；播放确认后才预检下一首，取消及迟到结果不能启动旧歌曲。
- 本地文件导入、设置和曲库持久化、损坏配置保留与备份恢复；**待播队列、历史、冷却和礼物资格不跨进程恢复**。
- 有界阶段记录和固定错误码。管理快照含观众标识与请求内容，不能原样作为公开 OBS 数据；显示层应自行选择公开字段。

接口说明见 [ADAPTERS.md](docs/ADAPTERS.md)。测试均使用合成事件和播放器；宿主必须执行真实音频、断连、取消、权限和长期运行验收。此源码发布不会更新 FurryUP Studio 安装器或插件渠道。
