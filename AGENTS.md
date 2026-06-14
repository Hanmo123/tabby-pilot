# AGENTS.md - Tabby Pilot 开发指南

**项目定位**: Tabby 终端的 AI Agent 插件，类似于 Copilot 之于 VSCode 的关系。提供对话式 AI 助手，支持执行 shell 命令。

## 回复指南

当你完成用户的需求后，进行简要的总结即可，保持简洁明了，禁止长篇大论的描述。

## 核心命令

```bash
# 开发模式（推荐）
npm install
npm run build
TABBY_PLUGINS=$(pwd) tabby --debug

# 监听模式（自动重新构建）
npm run watch  # Terminal 1
TABBY_PLUGINS=$(pwd) tabby --debug  # Terminal 2
# 代码变更后需重启 Tabby

# 安装到用户插件目录
cd ~/.config/Tabby/plugins/
npm install /path/to/tabby-pilot
# 或用符号链接: ln -s /path/to/tabby-pilot node_modules/
```

## 架构要点

### 技术栈
- **Angular 15** + TypeScript 4.9
- **Vercel AI SDK** (`ai`) + **Anthropic SDK** (`@ai-sdk/anthropic`)
- **Webpack 5** + `@ngtools/webpack`
- **Tabby 插件系统**: Provider-based DI（依赖注入）

### 关键依赖处理

**必须使用 `externals` 而非 bundle**: Tabby 核心模块（Angular、tabby-core、tabby-settings）必须声明为 webpack externals 和 peerDependencies，否则会因重复实例化导致 Angular 依赖注入失败。

```javascript
// webpack.config.mjs
externals: [
    '@angular/core',
    '@angular/common',
    'tabby-core',
    'tabby-settings',
    'rxjs',
    /^rxjs\//,  // 注意：rxjs 子路径也要排除
]
```

**AI SDK 必须 bundle**: `ai` 和 `@ai-sdk/anthropic` 是业务依赖，必须打包进 `dist/index.js`，因此在 `dependencies` 而非 `peerDependencies`。

### 样式加载规则

```javascript
// component.scss → 转换为字符串（Angular component styles）
{ test: /\.scss$/, use: ['to-string-loader', 'css-loader', 'sass-loader'], include: /component\.scss$/ }

// 全局样式 → 注入 DOM
{ test: /\.scss$/, use: ['style-loader', 'css-loader', 'sass-loader'], exclude: /component\.scss$/ }
```

### 插件注册机制

1. `package.json` 必须包含 `"keywords": ["tabby-plugin"]`
2. `main` 字段指向 `dist/index.js`（UMD 格式）
3. 默认导出必须是 `@NgModule` 装饰的类
4. Providers 通过 `multi: true` 注册到 Tabby 核心

```typescript
// src/index.ts
@NgModule({
    providers: [
        { provide: ConfigProvider, useClass: PilotConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: PilotSettingsTabProvider, multi: true },
        { provide: HotkeyProvider, useClass: PilotHotkeyProvider, multi: true },
    ],
})
export default class PilotModule { ... }
```

## 工作流程

### Shell 命令执行流程
1. AI 调用 `executeShell` tool
2. `ai.service.ts` 触发 `onToolCall` 回调
3. `pilotTab.component.ts` 将命令加入 `pendingToolExecutions`
4. UI 显示确认卡片（Approve/Reject）
5. 用户批准后执行 `execSync(command)`，拒绝则返回 `cancelled: true`

### 会话管理
- `SessionService` 管理多会话，存储在 Tabby config (`this.config.store.pilot.sessions`)
- 每个会话包含 `id`、`name`、`messages` 数组
- 当前会话 ID 存储在 `SessionService.currentSessionId`

## 已知限制和陷阱

1. **CWD 问题**: `execSync` 在默认目录执行，非活动终端的 CWD
2. **Angular JIT 模式**: 使用 JIT 编译（`jitMode: true`），避免 AOT 复杂性
3. **热键默认值**: `config.ts` 中 `platformDefaults` 必须匹配 `Platform` enum 值（macOS/Windows/Linux）
4. **API Key 安全**: 明文存储在 Tabby config JSON 中
5. **构建产物**: 必须保留 source maps（`devtool: 'source-map'`）便于调试
6. **优化关闭**: `optimization.minimize: false` 避免破坏 Angular 反射元数据

## 调试技巧

```bash
# 查看 Tabby 日志
tail -f ~/Library/Logs/Tabby/log.log  # macOS
tail -f ~/.config/Tabby/logs/log.log  # Linux

# 打开 DevTools
Cmd+Shift+I (macOS) / Ctrl+Shift+I (Windows/Linux)

# 验证插件加载
# 1. Settings → Plugins → Installed 应显示 "tabby-pilot"
# 2. Settings 应有 "Pilot" 标签
# 3. Settings → Hotkeys 搜索 "pilot" 应显示快捷键

# 验证构建产物
ls -lh dist/index.js dist/index.js.map
```

## 文件结构关键点

```
src/
├── api/
│   ├── index.ts           # 导出类型
│   └── interfaces.ts      # ChatMessage, ToolExecution 等接口
├── components/
│   ├── pilotTab.component.ts        # 聊天主界面
│   ├── pilotTab.component.pug       # 模板
│   ├── pilotTab.component.scss      # 样式
│   ├── pilotSettingsTab.component.ts  # 设置页面
│   ├── pilotSettingsTab.component.pug
│   └── pilotSettingsTab.component.scss
├── services/
│   ├── ai.service.ts      # AI SDK 集成，streamText + tools
│   └── session.service.ts # 会话管理和持久化
├── config.ts              # ConfigProvider (默认值、热键)
├── hotkeys.ts             # HotkeyProvider (热键定义)
├── settings.ts            # SettingsTabProvider (设置标签)
└── index.ts               # 模块入口，提供 NgModule
```

## 扩展开发建议

- **添加新 tool**: 在 `ai.service.ts` 的 `tools` 对象中添加，遵循 Vercel AI SDK 的 `tool()` API
- **修改热键**: 编辑 `config.ts` 的 `platformDefaults`，重启 Tabby 生效
- **添加设置项**: 在 `config.ts` 的 `defaults.pilot` 中定义，在 `pilotSettingsTab.component` 中绑定 UI
- **自定义主题**: 通过 Tabby 的 CSS 变量 (`--theme-*`) 自动继承主题
