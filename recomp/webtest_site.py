import sys, json
from playwright.sync_api import sync_playwright
steps=json.loads(sys.argv[1]); url=sys.argv[2]
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
    pg=b.new_page(viewport={'width':1000,'height':900}, color_scheme='dark')
    pg.on('pageerror', lambda e: print('PAGEERROR', str(e)[:300]))
    pg.on('console', lambda m: print('console.error:', m.text[:200]) if m.type=='error' else None)
    pg.route('**/fonts.googleapis.com/**', lambda r: r.abort())
    pg.goto(url)
    for s in steps:
        if s[0]=='wait': pg.wait_for_timeout(s[1])
        elif s[0]=='frames':
            f0=pg.evaluate('window.__state?window.__state().frames:0')
            for _ in range(800):
                pg.wait_for_timeout(250)
                if pg.evaluate('window.__state?window.__state().frames:0')>=f0+s[1]: break
        elif s[0]=='key': pg.keyboard.press(s[1], delay=80)
        elif s[0]=='type': pg.keyboard.type(s[1], delay=90)
        elif s[0]=='eval': print('eval ->', pg.evaluate(s[1]))
        elif s[0]=='page': pg.screenshot(path=s[1], full_page=True); print(s[1])
        elif s[0]=='stage': pg.locator('#stage').screenshot(path=s[1]); print(s[1], pg.evaluate('JSON.stringify(window.__state())'))
        elif s[0]=='shot': pg.locator('#screen').screenshot(path=s[1]); print(s[1], pg.inner_text('#status'))
    print('LOG:\n'+pg.evaluate('document.getElementById("log").textContent')[-1500:]); b.close()
