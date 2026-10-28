# 安全模型 / Security model

这份文档说明 `dsh-pet-ledger` 信任什么、读写了什么、以及它**故意不做**什么。
内容以 `src/host.js`、`src/ledger.js`、`src/store.js` 为准。
**文档与代码不一致时，代码是对的，这份文档有 bug。**

> 一句话：它是一个**只读观察者 + 一个本机 JSON 账本 + 一个无鉴权的面板路由**。
> 它不能给你授权，也不能阻止工具调用；它把命令和结果写进本机文件，供你自己核对。

## 信任边界

插件跑在 DSH 宿主进程里，订阅以下事件：

| 事件 | 用途 |
| --- | --- |
| `tools/pre-execute` | 记录即将发生的调用；waterfall 里**永远** `next()` |
| `tools/result` | 记录结果、失败、耗时、证据 |
| `agent/status` | 记录 agent 的 `running` / `idle`，用于真实任务时长 |
| `session/event` | 读取 `turn/end` 的结束原因 |
| `session/created` | 记录会话 `cwd` |
| `agent/disposed` | 清理该会话的运行时状态 |

`tools/pre-execute` 只观察，不返回 `deny` / `ask`，不会改变参数，也不会沙箱化执行。
记录逻辑本身抛异常时会被吞掉，绝不阻塞工具调用。

它注册一个 web 路由：

```
/dsh-pet-ledger
  GET  /state       返回快照
  POST /demo        生成演示卡（仅内存）
  POST /demo-clear  清除演示卡
```

路由**没有 token / cookie / CSRF 保护**，依赖 DSH Web server 自身的访问控制。
和面板同源的本机页面、脚本或进程都可以读写这些接口。

## 它读什么

- 工具名、工具参数（`exec.arguments`）、工具结果的结构化文本（`resultText`）。
- `agent.id`（即 `SessionId`）、`session.header.cwd`。
- 本机账本文件 `$DSH_HOME/pet-ledger.json`（可用 `dataPath` 覆盖）。

它**不读**会话消息正文、不读附件、不读项目文件、不调用模型、不发网络请求。

## 它写什么

- 只写 `dataPath` 指向的一个 JSON 文件。
- 写入是「临时文件 + rename」；失败会被记录到快照的 `capture.saveError`，不会抛给调用方。
- 文件里包含：真实成就、每条成就的证据行、当天统计、已生成的任务、计数器。
- **不包含**演示记录（只在内存）、运行时 streak、API key、cookie、token。

文件内容示例（节选）：

```json
{
  "achievements": [
    {
      "id": "long-task-1",
      "title": "长跑完赛",
      "sessionId": "122fe1b0-...",
      "evidence": [
        { "line": "node -e \"setTimeout(...)\"", "result": "pet-ledger-long-task-ok", "ok": true }
      ]
    }
  ]
}
```

## 敏感数据

- 证据里的 `line` 来自工具参数，`result` 来自结果摘要。**如果命令里含 token、密码、私钥路径，
  它们会原样进入本机 JSON 和面板。** 本插件不做脱敏。
- 数据只在本机；不会上传、不会发遥测、不会写日志到别处。
- 本机其他进程、同 profile 的其他插件、以及能访问 DSH Web 的页面都能读到这些内容；
  这不是一个加密账本，也不是权限边界。

## 鉴权现状

- 路由没有身份概念；`GET` 与两个 `POST` 都不校验来源。
- `POST /demo` 只影响内存里的演示数组，**不能**产生真实成就、不能改计数器、不能写盘。
- `POST /demo-clear` 只清内存演示数组。
- 没有「通过 HTTP 删除真实成就」的接口；要清空真实账本，只能停插件后手动删文件。
- 面板只读快照；所有真实成就的写入都发生在 host 事件处理里，客户端无法伪造。

## 已知限制（设计取舍）

1. **不是安全边界**：同进程插件可以绕过事件、直接改 `pet-ledger.json`，也可以伪造事件。
2. **没有路由鉴权**：能访问 DSH Web 的本机页面可以读快照、生成/清除演示卡；不能授予真实成就。
3. **证据可能含敏感命令**：不做脱敏；不要在会进入账本的命令里明文写凭据。
4. **失败判定是启发式**：`isError`、非零 `exitCode`、`[exit code: N]` 三种；其他自定义失败格式可能漏判。
5. **命令分类是启发式**：只影响任务类型与「测试红转绿」识别，不影响工具调用的真实执行。
6. **文件损坏会回退为空账本**：解析失败时保留错误信息，但不尝试修复；旧数据可能不可恢复。
7. **演示不落盘**：重启后消失；这是为了避免演示数据混入历史，不是 bug。
8. **面板轮询 1.5 秒**：不是实时推送；刚发生的事件最多延迟一个轮询周期。

## 明确不算漏洞

- 演示卡带水印、不计入真实成就：这是功能语义。
- 本机用户能改 `pet-ledger.json`：账本是本地记录，不是防篡改账本。
- 路由无鉴权但只能影响演示数据：见「鉴权现状」。
- 失败命令被记录为失败：这是账本的目的。

## 报告漏洞

请用 GitHub 私密渠道：
<https://github.com/dingchenhui0618-arch/dsh-pet-ledger/security/advisories/new>

个人项目，不承诺响应时限；会读、会修，修完写进 `CHANGELOG.md` 并说明影响范围。
请不要把仍在生效的问题先发到公开 issue。

## 支持范围

只维护最新一版（当前 `0.1.x`）。更早版本不单独回补。
