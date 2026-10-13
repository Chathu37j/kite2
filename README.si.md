# CryptoKite: GitHub එකේ දාලා phone එකෙන් පාවිච්චි කරන හැටි

මේක **browser එක ඇතුළේම** වැඩ කරන app එකක්. Server එකක්, API key එකක්, Python එකක් ඕන නෑ. Binance public data විතරයි ගන්නේ.

## GitHub එකේ දාන්න (පියවර 5)
1. GitHub account එකක් හදන්න. **Public** repository එකක් හදන්න (නම: `cryptokite`).
2. මේ folder එකේ ඔක්කොම (docs folder එක ඇතුළුව) upload කරන්න. Repository page එකේ **Add file → Upload files** ඔබලා files drag කරන්න. Folder structure එක වෙනස් කරන්න එපා (`docs/` එක තියෙන්න ඕන).
3. **Settings → Pages → Build and deployment**: Source = **Deploy from a branch**, Branch = **main**, Folder = **/docs** තෝරලා **Save**.
4. විනාඩියකට පස්සේ ලිපිනය මෙහෙමයි: `https://<ඔයාගේ-නම>.github.io/cryptokite/`
5. ඒක phone එකේ open කරන්න.
   * **Android (Chrome)**: ⋮ menu → **Install app** හෝ **Add to Home screen**
   * **iPhone (Safari)**: Share → **Add to Home Screen**

එතකොට ඒක සාමාන්‍ය app එකක් වගේ Home screen එකේ icon එකක් එක්ක open වෙනවා.

## Computer එකේ
`docs/index.html` file එක double-click කළත් වැඩ කරනවා.

## Binance block වෙලා නම්
⚙ **Settings** එකේ "API address" දාන්න (Spot / Futures), නැත්නම් VPN එකක් පාවිච්චි කරන්න. Error එකේ **451** කියලා තිබුණොත් ඒ region එක Binance block කරලා.

## Paper trading tracker (Track tab) - අලුත්

**Track** කියලා tab එකක් අලුතින් එකතු කළා. Signal tab එකේ **📌 Track this signal** button එක එබුවම, දැන් තියෙන signal එක
(entry, stop-loss, target 3ම) එයාගේම වෙනම live chart එකකට එකපාරටම add වෙනවා. ඒ chart එකේ stop-loss එකයි target 3ම fixed
lines විදියට පෙන්නනවා, Binance live price stream එකෙන්ම update වෙනවා. Binance account එකකට log වෙන්නවත් real order
එකක් දාන්නවත් ඕන නෑ - ඒත් target එක හරියටම hit වෙනවද, stop එකට වැටෙනවද කියලා ඇහැරෙන්නම බලාගන්න පුළුවන්.
Target 3 එකට ආවම, stop එකට වැටුනාම, හෝ අතින් "Close now" කළාම - **Profit** (කොළ) හෝ **Loss** (රතු) card එකක් ඉබේම
හැදෙනවා, % return එකත් එක්ක. Signal ගණනාවක්ම track කරන්න පුළුවන්, එකින් එකට වෙනම chart එකක් සහ history එකක් තියෙනවා.
ඔක්කොම ඔයාගේ phone/browser එකේම save වෙනවා (localStorage), වෙන කිසිම තැනකට යන්නේ නෑ.

## Optional News/Market mood signal - අලුත්

Signal tab එකේ **Outlook** card එකට දේවල් දෙකක් තව එකතු කරගන්න පුළුවන් — දෙකම optional, දෙකම **BUY/SELL signal එකට** හෝ backtest එකකට කිසිසේත් බලපාන්නේ නෑ (news/market mood ඉතිහාසගතව test කරන්න බැරි නිසා, discretionary Outlook read එකට විතරයි):

* **Market mood (Fear & Greed Index)** — API key ඕන නෑ, default on. Reach කරගන්න බැරි වුණොත් ඒ line එක නොපෙනී යනවා විතරයි.
* **Coin-specific news sentiment** — [cryptopanic.com/developers](https://cryptopanic.com/developers/api/) එකෙන් free API key එකක් අරන් ⚙ Settings එකේ දාන්න. Key එකක් නැතුව app එක කලින් වගේම වැඩ කරනවා. Key එකක් දැම්මොත් "News sentiment" line එකයි headlines කිහිපයක් Outlook එකේ පේනවා. Key එක වැරදි වුණත් crash වෙන්නේ නෑ, ඒ line එක නොපෙනී යනවා විතරයි.

## Auto-trailing stop-loss (Track tab)

Track කරපු signal එකක Target 1 hit වුණාම stop-loss එක entry price එකට (breakeven) ඉබේම move වෙනවා. Target 2 hit වුණාම stop-loss එක Target 1 මට්ටමට move වෙනවා. ඒ නිසා Target 1 ට ආපු trade එකක් දැන් **loss එකක් විදියට close වෙන්න බෑ**. Detail view එකේ "Auto-trail stop" toggle එකෙන් මේක off කරන්නත් පුළුවන්.


### Chart එකේ දැන් හැම hit එකක්ම exact time එකත් එක්ක

Entry, Target 1/2/3, Stop-loss — මේ ඔක්කොම chart එකේ **hit වුණු exact වෙලාවත් එක්ක** pin කරලා පේනවා (කලින් තිබ්බේ
price line විතරයි). එකම වෙලාවකදී targets ගණනාවක් hit වුණොත් labels overlap නොවී stack වෙනවා. Profit/Loss card
එකේත් දැන් වැඩිපුර විස්තර: entry→close prices සහ times, targets ලැබුනු පිළිවෙල, planned risk එකට සාපේක්ෂව
**R-multiple** එක, සහ trade එකේදී ලැබුනු හොඳම/නරකම මිල.


## Offline Replay: පැය ගණනක් වැහිලා තිබුණත් tracker එක හරි

Track කරපු (සහ pending) හැම signal එකක්ම අන්තිමට check කළ candle එක මතක තියාගන්නවා. App එක ආයෙත් open කරද්දී,
screen එක off කරලා ආයෙත් on කරද්දී, හෝ tab එක ආයෙත් open කරද්දී - මග හැරුණු CLOSED candles ඔක්කොම (ගාබ් එකට
ගැලපෙන විදියට interval එකක් තෝරලා, request එකකින්ම) replay කරලා entry, targets, stop trailing ඔක්කොම ඉතිහාසයෙන්ම
ආයෙත් ගණනය කරනවා. Candle එකක stop එකයි target එකයි දෙකම touch වුණොත් stop එක කලින් hit වුණා කියලා උපකල්පනය කරනවා.

## Daily Signal List: auto-detect කරපු top 10, auto හෝ manual entry

Track tab එකේ **Signal list** කියලා tab එකක් - දිනකට වරක් (app එක open ව තියෙද්දී විතරයි, server එකක් නැති නිසා
app එක නොහැරපු දවසක් skip වෙනවා) coins වැඩිම liquid ඒවා scan කරලා ensemble score, regime අනුව rank කරනවා.
**Auto-add** (⚙ Settings, default on) කළොත් top 10 pending entries විදියට auto-arm වෙනවා - price එක entry zone
එකට ආවම පැය 24ක් ඇතුළත auto-fill වෙනවා, නැත්නම් expire වෙනවා. Off කළොත් list එකම පේනවා, **Add as pending** සහ
**Track now** buttons වලින් manual ව එකතු කරගන්න පුළුවන්. මේවා කිසිවක් real order එකක් නෙවෙයි.

## ඇයි Binance/Bybit වලට real trade දාන්නේ නෑ

1. Exchange වල order දාන endpoints (API key/secret ඕන ඒවා) සාමාන්‍යයෙන් browser එකකින් කෙලින්ම call කරන්න ඉඩ දෙන්නේ නෑ (CORS restriction) — ඒක exchange එකේම security නීතියක්.
2. Trade කරන්න පුළුවන් API key එකක් publicly host කරපු website එකක browser storage එකේ තියෙන එක අනාරක්ෂිතයි — කවුරු හරි hack කළොත් හෝ browser extension එකක් හරහා ගියොත් සල්ලි අහිමි වෙන්න පුළුවන්.

ඒකට ආරක්ෂිත ක්‍රමය: ඔයාගේම computer එකේ විතරක් run කරන local script එකක් (Python), API key එක ඔයාගේ computer එකේම local file එකක තියෙන, කවදාවත් internet එකට upload නොවෙන එකක්. ඕන නම් මම `python/` folder එකට testnet default, `--live` flag එකකින් විතරක් real trade දාන, ඔයාගේ risk % එකෙන්ම position size calculate කරන, TP1→breakeven TP2→Target1 stop-trail logic එකම දාන trading script එකක් හදලා දෙන්නම්.

## Phone එකේ chart එක පාවිච්චි කරන හැටි
* ඇඟිල්ලෙන් අදින්න: chart එක වමට / දකුණට යනවා
* ඇඟිලි දෙකෙන් pinch කරන්න (හෝ **+ / −** බොත්තම්): zoom
* ඇඟිල්ල තත්පරයක් තද කරගෙන ඉන්න: crosshair එකෙන් OHLC සහ score පෙනෙනවා
* **▲ UP / ▼ DOWN** ඊතලය: අපේක්ෂිත චලනය සහ කාල පරාසය (පාට කළ කොටුව). "ENTRY WINDOW" පෙදෙස: trade එකට ඇතුල් වෙන්න පුළුවන් කාලය
* උඩ තියෙන පිල් (chips) වලින් trend lines, levels, forecast වගේ දේවල් on/off කරන්න

## Live signals
* **PENDING**: score එක trigger එක පහු කරලා තියෙනවා, ඒත් candle එක තවම close වෙලා නෑ. Close වෙද්දී තහවුරු වෙනවා නම් විතරයි ඇත්ත signal එක.
* Countdown එකෙන් candle close වෙන්න තියෙන වෙලාව පෙනෙනවා. Trade එකට ඇතුල් වෙන්න හොඳම වෙලාව close වුණාට පස්සේ, entry window එක ඇතුළත.
* **Settings** එකේ beep සහ notification on කරන්න පුළුවන්. (Browser එක / app එක open කරලා තියෙන්න ඕන.)

මතක තියාගන්න: මේක analysis මෙවලමක් විතරයි. Stop-loss අනිවාර්යයි, එක trade එකකට account එකෙන් 1–2% ට වඩා අවදානම් කරන්න එපා.
