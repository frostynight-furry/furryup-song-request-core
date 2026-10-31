# FurryUP Song Request Core

[English](README.en.md) · MIT · **0.2.0 预览版**

由[夜霜（FrostyNight）](https://github.com/frostynight-furry)发起并维护，源自 [FurryUP Studio](https://frostynight.top/furryup) 的通用组件。

**主播使用完整产品：**[FurryUP Studio 官网](https://frostynight.top/furryup) · [下载安装包](https://github.com/frostynight-furry/furryup-studio-releases)

**开发者接入本组件：**[快速开始](#运行) · [适配器契约](docs/ADAPTERS.md)

从 FurryUP Studio 拆出的 Node.js 点歌引擎：解析弹幕指令、匹配歌名与歌手、串行排队、取消、同曲换源、下一首预检、个人推荐轮播与阶段诊断。无需 Electron，无运行时 npm 依赖。

本仓库提供机制和适配接口。它不连接直播平台，不包含 QQ / 网易云 / 汽水登录或搜索服务，也不提供真实音频播放器。演示中的音乐服务和播放完成信号都是合成数据。FUS 宿主已用真实 QQ / 网易云账号完成一次静音 8 倍速轮换及整曲结束测试；**真实直播连续点歌、所有歌曲的账号权益和 OBS 收音仍待验收**。范围和记录见 [0.2.0 变更说明](docs/CHANGES-0.2.0.md)。

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

## 个人推荐续播

宿主在原有 `providers.search/resolve` 之外实现 `providers.recommend(provider, { signal })`，返回该账号可用的推荐歌曲元数据。播放器就绪后：

```js
engine.startRecommendations();
engine.configureRecommendations(true);
```

需要同时启用点歌及 `autoPlay`。空队列默认从 QQ 开始，QQ、网易云每首轮换；有人点歌时先播完当前推荐，再按到达顺序播放点歌；队列清空后恢复下一平台的推荐。推荐不占观众点歌名额，暂停及紧急停止同样生效。关闭推荐开关会让当前歌曲正常结束。

开关与下一平台单独保存在 `music-recommendations.json`，已有点歌设置和曲库无需迁移。推荐获取失败会尝试另一平台并限速重试；近期同曲会去重。个人推荐读取、登录和完整播放权限由宿主适配器负责。详细契约见 [ADAPTERS.md](docs/ADAPTERS.md#personal-recommendations)。

## 组件范围

- 支持四种规范化平台标识：`bilibili`、`douyin`、`kuaishou`、`wechat`；它们是事件字段，不代表附带四个平台的采集器。
- 音源标识为 `local`、`netease`、`qq`、`qishui`；`auto` 搜索宿主标记为已配置的来源。平台名称不代表该服务已经接入。
- 顺序准入、歌曲去重、同观众冷却、按平台/房间/观众隔离的礼物资格、撤回自己的最新待播请求。
- 暂停、跳过、清空、紧急停止、失败换源与继续下一首；播放确认后才预检下一首，取消及迟到结果不能启动旧歌曲。
- 本地文件导入、设置和曲库持久化、损坏配置保留与备份恢复；**待播队列、历史、冷却和礼物资格不跨进程恢复**。
- 有界阶段记录和固定错误码。管理快照含观众标识与请求内容，不能原样作为公开 OBS 数据；显示层应自行选择公开字段。
- `点歌 晴天 周杰伦` 等空格格式会优先匹配完整歌手名，避免独唱和合唱一起出现时误判；只写歌名、多首不同录音及明确版本的歧义保护保留。

接口说明见 [ADAPTERS.md](docs/ADAPTERS.md)。测试均使用合成事件和播放器；宿主必须执行真实音频、断连、取消、权限和长期运行验收。此源码发布不会更新 FurryUP Studio 安装器或插件渠道。

## 关于夜霜与 FurryUP Studio

夜霜（FrostyNight）发起并维护本仓库，也开发面向主播的 FurryUP Studio。FurryUP Studio 将直播工作台、助手、桌面陪伴与投屏等工作流组织在统一桌面界面中，并提供安装包及应用、插件更新入口。产品介绍见[官网](https://frostynight.top/furryup)，可用版本和更新记录见[下载仓库](https://github.com/frostynight-furry/furryup-studio-releases)。

本仓库是供开发者集成的独立点歌引擎，不是开箱即用的完整点歌产品。实际音源、账号服务、播放器和直播事件接入由宿主实现；独立组件的源码发布不表示公开版 FurryUP Studio 已同步包含该版本或新功能。

## 自愿致谢

如果本组件对你的项目有帮助，欢迎在 README、文档或关于页注明使用了 FurryUP Song Request Core，并链接项目、维护者与 FurryUP Studio。可直接复制下面的中文或英文示例：

```markdown
本项目使用 [FurryUP Song Request Core](https://github.com/frostynight-furry/furryup-song-request-core)，由[夜霜（FrostyNight）](https://github.com/frostynight-furry)发起并维护。了解其来源产品：[FurryUP Studio](https://frostynight.top/furryup)。
```

```markdown
This project uses [FurryUP Song Request Core](https://github.com/frostynight-furry/furryup-song-request-core), initiated and maintained by [FrostyNight (夜霜)](https://github.com/frostynight-furry). Learn about the product it originated from: [FurryUP Studio](https://frostynight.top/furryup).
```

上述致谢和链接完全自愿，不增加任何 [MIT 许可](LICENSE)条件。MIT 对软件副本或重要部分保留版权及许可声明的要求仍然有效。使用本组件或添加致谢不表示夜霜或 FurryUP Studio 对你的项目提供官方背书。
