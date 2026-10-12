window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-plugin-management',
  factory: () => ({
    name: 'sidebar-plugin-management',
    inject: ['market','slots'],
    apply(ctx) {
      const previous=ctx.market.settingsVisible();
      ctx.market.setSettingsVisible(false);
      ctx.on('dispose',()=>ctx.market.setSettingsVisible(previous));
      ctx.slots.inject('plugins.detail.section',()=>ctx.slots.register({
        name:'plugins.detail.section',id:'sidebar-market-browser',order:50
      },({subject})=>subject?.kind==='bundle'&&subject.pkg?.name==='dshmarket'
        ? ctx.market.render({preferredSubsectionId:'discover'}) : null));
    }
  })
});
