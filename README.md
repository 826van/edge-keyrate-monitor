# Key Rate Monitor

一个 Edge/Chrome 通用的 Manifest V3 插件，用来检测多个中转站账号里的密钥分组倍率。

## 设计方式

- 插件不保存你的网页登录密码。
- 检测请求使用 `credentials: include`，也就是复用浏览器当前已经登录的 cookie。
- 配置和检测结果只保存在本机浏览器的 `chrome.storage.local`。
- 插件会遮罩密钥提示，不展示完整 key。

## 安装

1. 打开 Edge：`edge://extensions/`
2. 打开左侧或页面上的 `开发人员模式`
3. 点 `加载解压缩的扩展`
4. 选择本目录：`edge-keyrate-monitor`

## 使用

1. 先在 Edge 里登录对应中转站后台。
2. 打开插件，点 `设置站点`。
3. 添加站点，填入能返回倍率分组的后台页面或 API 地址。
4. 选择解析方式：
   - `JSON`：适合后台接口返回 JSON。
   - `网页/文本正则`：适合只能抓后台 HTML 页面。
5. 保存后点 `保存并立即检测`。

## JSON 解析示例

如果接口返回：

```json
{
  "data": {
    "groups": [
      { "name": "default", "rate": 1 },
      { "name": "vip", "rate": 0.5 }
    ]
  }
}
```

那么配置：

- JSON 列表路径：`data.groups`
- 分组字段：`name`
- 倍率字段：`rate`

## 正则解析示例

如果页面里有：

```text
default 倍率: 1x
vip 倍率: 0.5x
```

可以使用：

```text
([^\n\r]+?)\s*(?:倍率|rate|ratio|multiplier)\s*[:：=]\s*([0-9.]+)\s*x?
```

第 1 个捕获组是分组名，第 2 个捕获组是倍率。

## 注意

不同中转站的后台接口不一样。最稳的方式是在打开后台页面后按 `F12`，进入 `Network`，刷新页面，找到返回密钥分组或倍率的接口 URL，再填到插件设置里。
