# Komari-Speedtest

Komari 插件：中國網路測速（插件代號 `cn-speedtest`）

在 Komari 後台或 Telegram 機器人上，讓任一節點（VPS）檢測到**中國電信 / 聯通 / 移動**的：

- **三網 TCP 延遲與丟包率**（IPv4 / IPv6）：平均、最小、最大、抖動、丟包率（含握手重傳次數），節點清單來自 [TcpQuality](https://github.com/ibsgss/TcpQuality) 的 getNodes 服務（全國各省三網）
- **泰爾測速與回程重傳率**（IPv4 / IPv6）：單線程 / 多線程上下行速度、延遲，以及測速期間每個測速點的**回程 TCP 重傳率**（與 TcpQuality 的「回程重傳」同一個指標），使用 [taierspeedtest-mod](https://github.com/MbaoWang/taierspeedtest-mod)（全球網測協議）

測試在**被選中的節點本身**透過 Komari Agent 的遠端執行（`admin:exec`）跑，結果回傳給 Komari 插件解析、儲存並顯示。

## 功能

| | Komari 後台頁面 | Telegram 機器人 |
|---|---|---|
| 選節點（可多選 / 全部在線） | ✅ | ✅ 互動按鈕、編號、名稱、`all` |
| 延遲 / 測速 / 完整 | ✅ | ✅ |
| IPv4 / IPv6 / 雙棧 | ✅ | ✅ |
| 測速點（北上廣、任選省份、可加運營商） | ✅ | ✅ 按鈕多選，或文字 `上海电信,广东` |
| 單線程 / 多線程 / 兩者 | ✅ | ✅ |
| 運營商（電信 / 聯通 / 移動，可多選） | ✅ | ✅ 按鈕多選，或文字 `電信 移動` |
| 測速失敗自動重測 | ✅ | ✅ |
| 歷史任務、上次結果 | ✅ | `/last`、按鈕 |
| 定時測試並推送 Telegram | 設定頁 | ✅ |
| 結果圖（PNG） | ✅ | ✅ 直接傳圖片 |
| 訪客公開結果頁 | ✅（可開關） | — |

## 安裝

1. 到 [Releases](https://github.com/MbaoWang/komari-speedtest/releases) 下載 `cn-speedtest.zip`，或自行執行 `./build.sh` 產生 `dist/cn-speedtest.zip`。
2. Komari 後台 → 插件 → 上傳 zip → 啟用（需同意權限：`node`、`allowRoutes`、`allowSystemRPC`）。
3. 打開插件設定：
   - Telegram：開啟「啟用 Telegram 機器人」，填 **Bot Token**（@BotFather 申請）與**允許的 Telegram ID**。
     不知道 ID：先存設定，對機器人傳 `/id`。
   - 其他參數都有預設值，可直接使用。
4. 後台側邊欄會出現「中國網路測速」頁面。項目預設為泰爾測速；測過之後，下次打開頁面會沿用上一次的設定（項目、協議、運營商、測速點、模式與勾選的節點，存在伺服器端，換電腦也一樣）。

需求：

- Komari ≥ 1.0.5（有插件系統的版本）
- 節點：Linux，已安裝 `curl`，Agent **沒有**加 `--disable-web-ssh`（否則無法遠端執行）
- 泰爾測速只支援 Linux **amd64 / arm64**；第一次會從 GitHub Release 下載約數 MB 的程式，快取在 `/tmp/kcst-bin`（每天更新一次）。
  國內節點連不上 GitHub 時，可在設定填鏡像網址，例如
  `https://ghfast.top/https://github.com/MbaoWang/taierspeedtest-mod/releases/latest/download/taierspeedtest-linux-{arch}`

## Telegram 用法

互動選單：`/menu` → 點節點 → 點「📶 延遲 IPv4 / IPv6 / 雙棧」「🚀 測速 …」「🧪 完整 …」；
「📍 選擇測速點」可多選省份，「⚙️ 模式」切換 單線程 → 多線程 → 單+多。

直接打字（可不加 `/`，繁簡都可）：

```
/ping HK-1 v6            三網延遲，IPv6
延遲 2 雙棧               用 /nodes 的編號
測速 HK-1 v4 上海,广东 多  泰爾測速，指定測速點與多線程
speed tokyo 上海电信,北京联通
全測 all                  所有在線節點：延遲 + 測速
/last HK-1               上次結果
/nodes  /jobs  /help  /id
```

- 節點可用：編號、名稱（不分大小寫，可部分符合）、UUID 前綴、`all` / `全部`。
- 協議：`v4` `v6` `雙棧`；模式：`單` `多` `單多`；運營商：`電信` `聯通` `移動`（可多個，例如 `延遲 HK-1 電信 移動`）。
- 名稱剛好是省份名稱的節點（例如叫「上海」）會被當成測速點，請改用編號。
- 完成後會回覆結果表格，附「🔁 再測一次」「📋 節點選單」按鈕。

伺服器連不到 `api.telegram.org` 時，可在設定填反向代理位址。

## 結果說明

- 延遲表：省份 × 三網，數字為**平均 TCP 握手延遲（ms）**；有丟包時顯示 `平均/丟包%`，`×` 表示完全不通。
- **丟包率**（參考 TcpQuality 以 TCP 握手探測的做法）：每個目標預設探測 20 次（設定可調 3~50，次數越多越準）。
  - 3 秒內握手失敗 → 丟包
  - 握手成功但比該目標最小延遲慢 ≥ 900 ms → 代表第一個 SYN / SYN-ACK 遺失、由核心在 1 秒後重送 → 也算丟包，並計入「握手重傳」
  - 平均 / 最小 / 最大 / 抖動只用沒有重傳的樣本計算，避免被 1 秒的重送拉高
  - 前 3 次全部不通的目標會提早結束（顯示 ×），不拖慢整體
- 測速表：測速點、延遲（泰爾測速伺服器的 ICMP 或 tcping）、單線程 / 多線程 下行 ↓ / 上行 ↑（Mbps）。
- 方向：↓ **去程**＝中國 → 節點（泰爾測速的下載），↑ **回程**＝節點 → 中國（泰爾測速的上傳，也就是你在國內用代理下載時的方向）。
- **回程重傳率**（測速期間）：每個測速點單獨執行一次泰爾測速，同時每 0.3 秒用 `ss -tinp` 讀取測速程式每條連線的 TCP_INFO，計算 重傳資料段 ÷ 送出資料段（`retrans` / `data_segs_out`）。
  - 這和 TcpQuality 的「回程重傳」是同一個方向、同一種算法（TcpQuality 用 `nstat TcpRetransSegs` / TCP_INFO 計算上傳時節點這端的重傳）。
  - 去程（下載）方向的重傳發生在對方伺服器，節點這端量不到，所以不顯示。
  - 節點沒有 `ss`（iproute2）時，改用 `/proc/net/snmp` 的 `RetransSegs / OutSegs` 系統整體計數器估算（標示 ≈，會受同時間其他流量影響）。
  - 顏色：< 1% 綠、1~5% 黃、> 5% 紅。

## 運營商選擇

可只測部分運營商（預設三網全部），**同時套用到延遲 / 丟包與泰爾測速**：

- 後台頁面：「運營商」按鈕可多選。
- Telegram：節點選單的「📡 運營商」，或文字指令加上 `電信` / `聯通` / `移動`（`ct` / `cu` / `cm` 也可以）。
- 插件設定「預設運營商」可改預設值（例如只填 `电信`）。
- 測速點若已指定運營商（如 `上海电信`），以測速點為準。

## 自動重測

泰爾測速某個測速點有任何一項速度失敗（0）或沒有結果時，會自動重跑該測速點，保留失敗最少的那一次：

- 設定「測速失敗自動重測次數」（0~3，預設 1；0 = 不重測）。
- 結果會標示「已自動重測：廣東移動 ×1」，重測後仍失敗會註明「仍有失敗」。
- 重測只針對泰爾測速；延遲 / 丟包本身就是多次探測取統計，不需要重測。

## 任務紀錄

- 預設保留最近 **40** 筆任務（設定「任務紀錄保留筆數」可調 10~200），超過自動刪除最舊的。
- 最近 15 筆保留完整結果，更舊的只留摘要。
- 後台「清除已完成」可一次刪除所有已結束的任務紀錄。
- 各節點的「最新結果」（`/last`、公開頁、上次結果）另外保存，不受刪除影響。

## 結果圖

每個節點測完會自動畫一張 PNG 報告圖（類似 TcpQuality 的報告圖：三網延遲 / 丟包表、泰爾測速 / 回程重傳表）：

- Telegram：預設直接傳圖片 + 簡短摘要（設定「Telegram 結果格式」可改成文字或兩者都傳）。
- Komari 後台頁面：結果上方顯示圖片，可下載。
- 設定「自動上傳結果圖到圖床」選 `catbox` 或 `0x0` 後，會取得公開網址並附在 Telegram 訊息與後台頁面（失敗會自動改試另一個）。上傳後任何人有網址都能看到，出口 IP 預設已遮罩。
- 圖片存在 `data/plugin-data/cn-speedtest/images/`，保留最近 120 張。
- 繪圖在插件內以純 JavaScript 完成（內建點陣中文字型，來自 Noto Sans CJK TC，SIL OFL 1.1，見 `plugin/lib/FONT-LICENSE.txt`），不需要安裝任何東西。字型以 `tools/build-font.py` 產生。
- 出口 IP 預設遮罩（`1.2.*.*`），可在設定開啟完整顯示。

## 訪客公開結果頁

插件設定開啟「開放訪客查看結果」後，任何人都可以在這個網址看各節點最近一次的結果（不用登入）：

```
https://你的Komari網址/api/plugin/cn-speedtest/public/
```

- 顯示各節點的三網延遲 / 丟包、泰爾測速 / 回程重傳、摘要數字與結果圖，可切換 IPv4 / IPv6、搜尋節點。
- 只顯示**未隱藏**的節點；**不含** IP、錯誤細節、任務紀錄，訪客也無法觸發測試。
- Komari 設為**私有站點**時，訪客需先登入才能看。
- 開啟「顯示完整出口 IP」時，公開頁不提供結果圖（避免圖片裡的完整 IP 外流）。
- 可以把這個網址加到 Komari 主題的自訂連結或導覽列，讓訪客容易找到。

## 運作方式

```
Telegram / 後台頁面
      │  /api/plugin/cn-speedtest/run（管理員）或 Bot 指令（白名單）
      ▼
插件 jobs.js ──admin:exec──▶ Komari Agent（sh -s）
      ▲                         ├─ curl getNodes → xargs -P 平行 tcping（curl time_connect）→ 延遲 / 丟包
      │                         └─ 逐點 taierspeedtest --json …  ＋ ss -tinp 取樣 TCP_INFO → 速度 / 重傳率
      └──admin:getTaskById（每 5 秒輪詢）◀── 結果文字（@@ 標記行 + JSON）
```

- 同一節點同時只會跑一個測試（節點端 `/tmp/kcst.lock`；插件端也會略過測試中的節點）。
- 所有插入 shell 的參數都經白名單檢查（測速點只允許中文 / 英文字母與逗號，網址不允許單引號等），防止指令注入。
- 後台頁面的「預覽節點指令」可以看到實際會在節點上執行的完整腳本。
- 狀態存在 `data/plugin-data/cn-speedtest/`（`state.json`、`telegram.json`），更新插件不會遺失。

## 後台 API（需管理員登入）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/plugin/cn-speedtest/overview` | 節點、最近任務、預設值 |
| POST | `/api/plugin/cn-speedtest/run` | `{clients:[uuid], type:"ping"\|"speed"\|"full", family:"4"\|"6"\|"both", points, mode, isps:["电信","联通","移动"]}` |
| GET | `/api/plugin/cn-speedtest/job?id=` | 任務與完整結果 |
| GET | `/api/plugin/cn-speedtest/latest?uuid=` | 節點最近結果 |
| GET | `/api/plugin/cn-speedtest/image?file=` | 結果圖 PNG |
| POST | `/api/plugin/cn-speedtest/cancel` | `{id}` 停止等待（節點端會自行跑完） |
| POST | `/api/plugin/cn-speedtest/jobs/clear` | 清除已結束的任務紀錄 |
| POST | `/api/plugin/cn-speedtest/preview` | 預覽節點指令 |
| POST | `/api/plugin/cn-speedtest/telegram/test` | 傳送 Telegram 測試訊息 |

公開 API（開啟公開頁後才可用）：`GET /api/plugin/cn-speedtest/public/data`、`GET /api/plugin/cn-speedtest/public/image?uuid=`。

RPC：`cnSpeedtest:run`、`cnSpeedtest:latest`。

## 開發

```
node --test tests/*.test.js   # 單元測試（解析、丟包 / 重傳率、結果圖 PNG、格式化、注入防護、sh 語法、Telegram 指令解析）
./build.sh                    # 測試 + 打包成 dist/cn-speedtest.zip
python3 tools/build-font.py   # 重新產生內建字型（需要 Pillow 與 fonts-noto-cjk）
```

發布：推送 `v*` 標籤（例如 `git tag v1.3.0 && git push origin v1.3.0`），GitHub Actions 會跑測試、打包並把 `cn-speedtest.zip` 附到 Release。

## 致謝與授權注意

- 延遲測試節點清單：[ibsgss/TcpQuality](https://github.com/ibsgss/TcpQuality)（GPL-3.0）的公開 getNodes 服務；本插件未複製其程式碼，只讀取節點清單。
- 測速：在節點上執行 [MbaoWang/taierspeedtest-mod](https://github.com/MbaoWang/taierspeedtest-mod) 的 Release 程式並讀取 `--json` 輸出。
- 這兩個服務由第三方維護，若其介面變更或停止服務，相應功能會失效；getNodes 失效時可在設定填「自訂延遲目標」。
- 僅供個人網路品質測試使用。

## 授權

- 程式碼：[AGPL-3.0](LICENSE)。
- 內建點陣字型 `plugin/lib/font-data.js`：由 Noto Sans CJK TC 產生，依 [SIL Open Font License 1.1](plugin/lib/FONT-LICENSE.txt) 授權，不適用 AGPL。
