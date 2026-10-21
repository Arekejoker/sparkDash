# 简体中文界面

这是 sparkDash 2.50 的社区简体中文分支，保留上游英文界面和一键 `EN / 中文` 切换。

## 范围

- 默认显示简体中文
- 右下角 `EN / 中文` 切换，选择保存在浏览器本地
- 覆盖侧边栏、概览、Spark 详情、Tokens、能耗、温度、活动、设置、基准测试等上游页面
- 模型名、单位、命令、版本号等技术内容保留英文
- 演示页的 prompt 内容不翻译，避免改变实际发给模型的内容
- 页面标题、按钮 `title`、`placeholder` 和 `aria-label` 也会翻译

## 实现方式

翻译由 `src/i18n/zh.ts` 词典和 `src/i18n/zhRuntime.ts` 运行时文本/属性翻译组成，不修改上游组件的文案来源。上游新增但词典里没有的字符串会回退为英文，需要补充对应词条。

这是一个社区构建，不是上游正在评审的 i18next 方案。上游中文国际化工作见：

- MiaAI-Lab/sparkDash #226（i18next 基础方案）
- MiaAI-Lab/sparkDash #200（全量中文 locale）

## 运行

完整的安装、Docker、局域网和手机访问说明见
[QUICKSTART.zh-CN.md](QUICKSTART.zh-CN.md)。

```bash
npm ci
npm run build
node server/index.js
```

部署配置和访问控制仍按上游 README 设置；本分支不包含任何 `.env`、配置、密钥或运行数据。

## License

上游 sparkDash 为 Apache-2.0，本分支沿用同一许可证。
