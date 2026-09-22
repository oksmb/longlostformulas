import base64, os, sys, json
from playwright.sync_api import sync_playwright
ROOT='/home/claude/re/recomp/gamefs'
steps=json.loads(sys.argv[1])   # [["wait",ms]|["key","Enter"]|["type","ABC"]|["shot","name.png"]|["hold","ArrowUp",ms]]
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--js-flags=--max-old-space-size=4096'])
    pg=b.new_page(viewport={'width':1000,'height':1100}, color_scheme='dark')
    pg.on('console', lambda m: print('console:', m.type, m.text[:300]) if m.type in ('error',) and 'ERR_' not in m.text else None)
    pg.on('pageerror', lambda e: print('PAGEERROR', str(e)[:400]))
    pg.route('**/fonts.googleapis.com/**', lambda r: r.abort())
    pg.goto('file:///mnt/user-data/outputs/lost-formulas-play.html')
    def feed():
        # feed files in chunks to avoid giant single messages
        batch=[]; size=0
        for d,_,fs in os.walk(ROOT):
            for f in fs:
                if f.lower().endswith(('.exe','.txt','.cfg')): continue
                pth=os.path.join(d,f); rel='\\'+os.path.relpath(pth,ROOT).replace('/','\\').upper()
                batch.append([rel, base64.b64encode(open(pth,'rb').read()).decode()]); size+=os.path.getsize(pth)
                if size>20e6: pg.evaluate('(e)=>window.__addRaw(e)', batch); batch=[]; size=0
        pg.evaluate('(e)=>{window.__addRaw(e); window.__start();}', batch)
    feed()
    for s in steps:
        if s[0]=='wait': pg.wait_for_timeout(s[1])
        elif s[0]=='key': pg.keyboard.press(s[1], delay=80)
        elif s[0]=='type': pg.keyboard.type(s[1], delay=90)
        elif s[0]=='hold': pg.keyboard.down(s[1]); pg.wait_for_timeout(s[2]); pg.keyboard.up(s[1])
        elif s[0]=='frames':
            f0=pg.evaluate('window.__state().frames')
            for _ in range(600):
                pg.wait_for_timeout(250)
                if pg.evaluate('window.__state().frames')>=f0+s[1]: break
        elif s[0]=='reload': pg.reload(); feed()
        elif s[0]=='eval': print('eval ->', pg.evaluate(s[1]))
        elif s[0]=='shot': pg.locator('#screen').screenshot(path=s[1]); print(s[1], pg.inner_text('#status'))
    st=pg.evaluate('window.__state()'); print(json.dumps({k:v for k,v in st.items() if k!='missing'}))
    print('log tail:', pg.inner_text('#log')[-700:]); b.close()
