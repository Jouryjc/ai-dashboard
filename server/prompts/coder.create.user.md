请做这样一个大屏：{{text}}{{answersBlock}}
{{dataBlock}}
{{templateContext}}
重要：上面的「真实数据」块只是数据形状参考，页面里的数值必须在运行时用数据读取范式从 data.json / 内联 dashboard-data 加载（D 数组结构与上方一致），禁止把看到的数值写死进 HTML。照下面的模板 HTML 还原样式，模板里的数字全是占位演示，必须用运行时读取的真实数据替换，禁止照抄模板数字。直接输出完整 HTML。{{imageNote}}
