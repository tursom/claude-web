# 本机用户服务

- 用户：root；原生 Node.js 服务，不使用 Docker。
- 服务：`~/.config/systemd/user/claude-web.service`。
- 代码与构建：`/root/dev/claude-web`。
- 配置：`/root/.config/claude-web/config.json`，权限 0600。
- 终端：省略 `terminal.shell`，自动使用服务用户的默认 Shell；本机 root 账户当前为 `/usr/bin/zsh`。修改配置后重启服务，新建终端生效。
- 监听：`0.0.0.0:8505`，8504 保留给现有 PI WEB。
- 浏览器入口：`https://cc.home.tursom.cn:20080/`。
- 认证：`authMode: "proxy"`，全部由 Pangolin 负责，后端不要求邮箱或身份头。
- `allowedOrigins`：`https://cc.home.tursom.cn:20080`。
- 已设置用户服务 enabled 与 root linger，退出登录后继续运行。

```sh
systemctl --user status claude-web
systemctl --user restart claude-web
journalctl --user -u claude-web -f
```

本机验证：不携带身份头的 HTTP、首页、WS 均成功；实际终端新建与关闭成功。公网入口返回 302，未携带登录态完成代理后的页面验证。未更改 Pangolin 配置或 PI WEB 服务。
