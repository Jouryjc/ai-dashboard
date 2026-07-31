这是当前大屏的完整 HTML：
{{currentHtml}}

用户要求修改：{{instruction}}
{{dataBlock}}
请输出修改后的完整 HTML（还是一个自包含文件，约束不变）。
注意：如果当前 HTML 里已有数据读取范式（fetch('./data.json') 或读取 dashboard-data 内联块），必须保留这套运行时取数逻辑，不要把数据改写死；上方的「真实数据」块只是数据形状参考。
