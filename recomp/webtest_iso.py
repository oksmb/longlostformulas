import sys, json
from playwright.sync_api import sync_playwright
steps=json.loads(sys.argv[1]); url=sys.argv[2] if len(sys.argv)>2 else 'http://127.0.0.1:8765/test.iso'
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
    pg=b.new_page(viewport={'width':1000,'height':1100}, color_scheme='dark')
    pg.on('pageerror', lambda e: print('PAGEERROR', str(e)[:300]))
    pg.route('**/fonts.googleapis.com/**', lambda r: r.abort())
    pg.goto('file:///mnt/user-data/outputs/lost-formulas-play.html')
    pg.evaluate('(u)=>{window.__startDisc(u)}', url)
    for s in steps:
        if s[0]=='wait': pg.wait_for_timeout(s[1])
        elif s[0]=='frames':
            f0=pg.evaluate('window.__state().frames')
            for _ in range(800):
                pg.wait_for_timeout(250)
                if pg.evaluate('window.__state().frames')>=f0+s[1]: break
        elif s[0]=='key': pg.keyboard.press(s[1], delay=80)
        elif s[0]=='type': pg.keyboard.type(s[1], delay=90)
        elif s[0]=='reload': pg.reload(); pg.evaluate('(u)=>{window.__startDisc(u)}', url)
        elif s[0]=='shot': pg.locator('#screen').screenshot(path=s[1]); print(s[1], pg.inner_text('#status'))
    print('LOG:\n'+pg.inner_text('#log')[-1500:]); b.close()
