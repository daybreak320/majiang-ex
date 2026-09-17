import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    'no-console': 'off',
    // 项目约定用大写规则编号前缀（R-XXX-v0：...）做 describe/it 标题，
    // 与 antfu 默认的「小写标题」规则冲突；该规则纯风格无实质收益，关掉以匹配项目约定。
    'test/prefer-lowercase-title': 'off',
  },
})
