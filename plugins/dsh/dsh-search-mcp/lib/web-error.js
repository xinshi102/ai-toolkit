/**
 * 本工作区适配：不再从 @deepseek-ai/dsh-web 导入 WebError。
 *
 * 原因：profile 里装的插件会把自己声明的 @deepseek-ai/* 依赖装成**第二份副本**，
 * 于是 `new WebError(...)` 出来的是另一份类的实例，宿主里任何 `instanceof WebError`
 * 判断都会失手；而宿主 `ctx.web.search()` 并不 try/catch provider 的异常
 * （见 dsh-web 的 search()），错误会原样冒到工具层，所以只要形状一致就够用：
 * `name = 'WebError'` + 稳定的 `code`。
 *
 * 顺带的好处：这个包不再需要依赖 @deepseek-ai/dsh-web（少装一份宿主包）。
 */
export class WebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'WebError';
    this.code = code ?? 'WEB_PROVIDER_ERROR';
  }
}
