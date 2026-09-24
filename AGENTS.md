# Agent 工作约定

- 每次完成代码或文档更改后，都要将本次相关文件提交到 Git，并在交付时说明提交结果。
- 每次更改后都要从干净状态重建供测试的桌面程序：先运行 `cargo clean`，再从仓库根目录运行 `npm run tauri -- build --debug --no-bundle`。Tauri CLI 会运行 `beforeBuildCommand` 构建前端，并将前端资源嵌入 debug 桌面程序。
- 不要用普通 `cargo build` 作为可交付的桌面测试程序：它可能仍指向 `tauri.conf.json` 中的开发地址 `localhost:1430`，未启动 Vite 时打开会显示 `ERR_CONNECTION_REFUSED`。
- Windows 测试程序必须生成在仓库根目录的 `target/debug/` 下（通常为 `target/debug/mindzj.exe`）。构建完成后确认文件存在；并确认启动程序不依赖运行中的 Vite 开发服务器，再报告路径。
- 提交时只暂存本次任务涉及的文件；不要把工作区中其他已有改动一并提交。
