/**
 * dsh-skill-jnkgg —— 浏览器半边（设置页注册）。
 *
 * 姿势（11-06 套件那版踩过坑验证过的）：
 *   设置页必须由 client 用 ctx.slots.inject('settings.section', ...) 注册；
 *   宿主端 webApp.settings.section 是不存在的 API。
 * 页面内容 = iframe 指向同源 /api/skill-jnkgg/page，服务端 HTML 原样可用。
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-jnkgg',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'settings.skillJnkgg';
    const SECTION_ID = 'skill-jnkgg';

    const DICT = {
      zh: { nav: '技能库管家', title: '技能库管家 · Skill JNKG' },
      en: { nav: 'Skill JNKG', title: 'Skill JNKG · Manager' },
    };

    function pageUrl() {
      const rel = 'api/skill-jnkgg/page';
      if (typeof document === 'undefined') return '/' + rel;
      return new URL(rel, document.baseURI).pathname;
    }

    function SettingsPage() {
      return h('div', { className: 'skilllib-root', style: { width: '100%' } },
        h('iframe', {
          src: pageUrl(),
          title: '技能库管家设置',
          style: {
            width: '100%', height: '80vh', minHeight: '640px',
            border: '1px solid var(--dsw-alias-line, #e2e8f0)', borderRadius: '10px',
            background: '#f5f7fa',
          },
        }),
      );
    }

    const name = 'dsh-skill-jnkgg';
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'skill-jnkgg: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 952,
          label: () => t('nav'),
          locale: NS,
        }, (props = {}) => h(SettingsPage, { ...props, t: props.t ?? t })));
      } catch (e) {
        try { ctx.logger.warn(`[skill-jnkgg client] 设置页注册失败: ${e && e.message}`); } catch { /* noop */ }
      }
    }

    return { name, inject, apply };
  },
});
