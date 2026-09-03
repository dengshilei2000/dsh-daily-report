// dsh-daily-report — Browser half.
// Sidebar entry (DOM injection, self-healing) + floating bottom-right entry +
// overlay panel. Talks to the Host half through /api/daily-report/* HTTP routes.
//
// Background-run UX: uploading / generating / sending may continue after the
// panel is closed. Closing the panel never aborts an in-flight request — the
// component stays mounted, keeps its state, and shows a small activity pill
// above the floating button while work runs (or after it finished while the
// panel was closed) so the user can return and see the result.
window.__ModuleLoader__.load({
	id: "dsh-daily-report",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom_client = require("react-dom/client");

		const API = "/api/daily-report";
		const MAX_UPLOAD_BYTES = 104857600;
		const ENTRY_SELECTOR = "[data-dsh-daily-report-entry]";
		const CSS = [
			".drp-launch{box-sizing:border-box;pointer-events:auto;width:100%;height:36px;border:0;border-radius:8px;background:rgba(128,128,128,.08);color:var(--dsw-alias-label-primary,#111827);cursor:pointer;display:inline-flex;align-items:center;justify-content:flex-start;gap:9px;padding:0 10px;font-family:inherit;font-size:13px;font-weight:500;overflow:hidden;box-shadow:inset 3px 0 0 0 var(--dsw-alias-brand-primary,#2563eb);transition:background .15s ease}",
			".drp-launch:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}",
			".drp-launch:active{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.22))}",
			".drp-icon{width:17px;height:17px;flex:none;display:block;color:inherit}",
			".drp-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".drp-float{pointer-events:auto;position:fixed;right:22px;bottom:22px;width:52px;height:52px;border:0;border-radius:16px;background:#2563eb;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(37,99,235,.45);z-index:2147482000;transition:background .15s ease,transform .15s ease}",
			".drp-float:hover{background:#1d4ed8;transform:translateY(-2px)}",
			".drp-float svg{width:24px;height:24px}",
			".drp-activity{position:fixed;right:22px;bottom:86px;display:inline-flex;align-items:center;gap:8px;max-width:min(360px,72vw);box-sizing:border-box;border:0;border-radius:999px;padding:9px 14px;font-family:inherit;font-size:13px;font-weight:600;color:#fff;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.28);z-index:2147482500;transition:transform .15s ease}",
			".drp-activity:hover{transform:translateY(-1px)}",
			".drp-activity-running{background:#2563eb}",
			".drp-activity-done{background:#059669}",
			".drp-activity-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".drp-spinner{width:14px;height:14px;flex:none;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:drp-spin .8s linear infinite}",
			"@keyframes drp-spin{to{transform:rotate(360deg)}}",
			".drp-overlay{pointer-events:auto;position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px}",
			".drp-mask{position:absolute;inset:0;background:rgba(15,23,42,.72)}",
			".drp-panel{position:relative;box-sizing:border-box;width:min(1120px,96vw);max-height:94vh;overflow:auto;border:1px solid #1f2937;border-radius:16px;background:#ffffff;color:#111827;box-shadow:0 24px 80px rgba(0,0,0,.45);padding:26px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
			".drp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}",
			".drp-head h1{margin:0;font-size:24px;color:#111827}",
			".drp-head p{margin:6px 0 0;color:#4b5563;font-size:13px}",
			".drp-close{border:0;background:#e5e7eb;color:#111827;font-size:26px;line-height:1;cursor:pointer;border-radius:8px;width:34px;height:34px;flex:none}",
			".drp-close:hover{background:#d1d5db}",
			".drp-boxes{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}",
			".drp-box{display:block;border:1px solid #d1d5db;border-radius:12px;padding:14px;background:#ffffff}",
			".drp-box>strong{display:block;margin-bottom:6px;font-size:16px;color:#111827}",
			".drp-box>small{display:block;margin-bottom:10px;color:#4b5563;line-height:1.5}",
			".drp-upload{border:1px dashed #9ca3af;border-radius:10px;background:#f9fafb;padding:10px 12px;margin-bottom:10px;color:#374151}",
			".drp-upload-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#1f2937;margin-bottom:6px}",
			".drp-file-input{width:100%;font-size:13px;color:#374151}",
			".drp-file-list{margin-top:6px;font-size:12px;color:#4b5563;line-height:1.6}",
			".drp-file-item{display:flex;justify-content:space-between;gap:8px;align-items:center}",
			".drp-file-remove{border:0;background:#fee2e2;color:#b91c1c;border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer}",
			".drp-file-preview{display:block;margin-top:4px;color:#6b7280;font-size:12px;white-space:pre-wrap;word-break:break-all}",
			".drp-textarea{box-sizing:border-box;width:100%;min-height:240px;border:1px solid #d1d5db;border-radius:10px;background:#ffffff;color:#111827;padding:12px;font-family:inherit;font-size:14px;line-height:1.6;resize:vertical}",
			".drp-textarea::placeholder{color:#9ca3af}",
			".drp-actions{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin-top:18px}",
			".drp-field{flex:1 1 250px}",
			".drp-field span{display:block;margin-bottom:7px;font-size:13px;font-weight:600;color:#111827}",
			".drp-input{box-sizing:border-box;width:100%;border:1px solid #d1d5db;border-radius:10px;background:#ffffff;color:#111827;padding:12px;font:inherit}",
			".drp-btn{border:0;border-radius:9px;padding:10px 16px;font-weight:700;font-size:14px;cursor:pointer}",
			".drp-primary{background:#2563eb;color:#ffffff}",
			".drp-primary:hover{background:#1d4ed8}",
			".drp-secondary{background:#ffffff;color:#1f2937;border:1px solid #d1d5db}",
			".drp-secondary:hover{background:#f3f4f6}",
			".drp-btn:disabled{opacity:.5;cursor:not-allowed}",
			".drp-status{margin-top:14px;padding:10px 12px;border-radius:8px;background:#f3f4f6;color:#111827;white-space:pre-wrap;font-size:13px}",
			".drp-error{background:#fef2f2;color:#b91c1c}",
			".drp-bg-hint{margin:10px 0 0;color:#6b7280;font-size:12px;line-height:1.6}",
			".drp-preview{margin-top:18px;border-top:2px solid #e5e7eb;padding-top:14px}",
			".drp-preview h2{font-size:18px;color:#2563eb;margin:14px 0 6px}",
			".drp-preview p{white-space:pre-wrap;line-height:1.7;color:#111827;margin:0}",
			".drp-download{display:inline-block;margin-top:12px;color:#2563eb;font-weight:600}",
			"@media(max-width:760px){.drp-boxes{grid-template-columns:1fr}.drp-textarea{min-height:180px}.drp-overlay{padding:8px}.drp-panel{padding:16px}.drp-activity{right:10px;bottom:80px}}"
		].join("");
		const ICON = '<svg class="drp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2.5"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>';
		const FLOAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2.5"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>';

		function readFileAsBase64(file) {
			return new Promise(function (resolve, reject) {
				const reader = new FileReader();
				reader.onload = function () {
					const result = String(reader.result || "");
					const comma = result.indexOf(",");
					resolve(comma >= 0 ? result.slice(comma + 1) : result);
				};
				reader.onerror = function () { reject(new Error("读取文件失败：" + file.name)); };
				reader.readAsDataURL(file);
			});
		}

		async function apiCall(path, body) {
			const response = await fetch(API + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			let value;
			try { value = await response.json(); } catch { value = null; }
			if (!response.ok) throw new Error((value && value.error) || ("请求失败：" + response.status));
			return value;
		}

		function sidebarRoot() {
			const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
			if (column === null) return undefined;
			const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
			return logoOwner ?? (column.firstElementChild || undefined);
		}

		function newSessionButton(root) {
			const nested = root.querySelector('button[class*="newSession"]');
			if (nested !== null) return nested;
			for (const child of root.children) {
				if (child.tagName === "BUTTON") return child;
			}
			return undefined;
		}

		function createEntry(onToggle) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.setAttribute("data-dsh-daily-report-entry", "");
			entry.setAttribute("data-dsh-plugin", "daily-report");
			entry.setAttribute("data-dsh-part", "sidebar-entry");
			entry.className = "drp-launch";
			entry.setAttribute("aria-label", "打开日报助手");
			entry.setAttribute("title", "日报助手");
			entry.innerHTML = "<span class=\"drp-icon-wrap\">" + ICON + "</span><span class=\"drp-label\">日报助手</span>";
			entry.addEventListener("click", onToggle);
			return entry;
		}

		function placeEntry(root, entry) {
			const button = newSessionButton(root);
			if (button === undefined) return false;
			if (entry.parentElement !== root) {
				const row = button.closest('[class*="logoRow"]');
				const base = (row !== null && row.parentElement === root) ? row : button;
				const family = Array.from(root.children).filter(function (el) { return el instanceof HTMLElement && el.matches(ENTRY_SELECTOR); });
				const anchor = family.length > 0 ? family[0] : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}

		let sidebarObserver = null;
		function mountSidebar(onToggle) {
			const tryInsert = function () {
				const root = sidebarRoot();
				if (root === undefined) return;
				let entry = root.querySelector(ENTRY_SELECTOR);
				if (entry === null) entry = createEntry(onToggle);
				placeEntry(root, entry);
			};
			tryInsert();
			if (sidebarObserver === null) {
				sidebarObserver = new MutationObserver(function () {
					const root = sidebarRoot();
					if (root !== undefined && root.querySelector(ENTRY_SELECTOR) === null) {
						const entry = createEntry(onToggle);
						placeEntry(root, entry);
					}
				});
				const root = sidebarRoot();
				if (root !== undefined) sidebarObserver.observe(root, { childList: true, subtree: true });
			}
		}

		function mountFloating(onToggle) {
			const existing = document.querySelector(".drp-float");
			if (existing !== null) return;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "drp-float";
			button.setAttribute("aria-label", "打开日报助手");
			button.setAttribute("title", "日报助手");
			button.innerHTML = FLOAT_ICON;
			button.addEventListener("click", onToggle);
			document.body.appendChild(button);
		}

		function Overlay() {
			const [open, setOpen] = react.useState(false);
			const [form, setForm] = react.useState({ morningMaterials: "", afternoonMaterials: "" });
			const [recipient, setRecipient] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [uploading, setUploading] = react.useState("");
			const [sending, setSending] = react.useState(false);
			const [status, setStatus] = react.useState("");
			const [error, setError] = react.useState("");
			const [generated, setGenerated] = react.useState(null);
			const [uploads, setUploads] = react.useState({ morning: [], afternoon: [] });
			const [doneClosed, setDoneClosed] = react.useState(null);
			const openRef = react.useRef(false);
			const fileInputs = react.useRef({ morning: null, afternoon: null });
			const pickFilesRef = react.useRef(null);
			react.useEffect(function () {
				const listener = function (value) {
					openRef.current = value;
					setOpen(value);
					if (value) setDoneClosed(null);
				};
				window.__drpSetOpenListener = listener;
				return function () { if (window.__drpSetOpenListener === listener) window.__drpSetOpenListener = null; };
			}, []);
			// Closing the panel never aborts in-flight work; when a task settles
			// while the panel is closed, remember it so the pill invites the user
			// back to see the result.
			const noteIfClosed = function (text) { if (!openRef.current) setDoneClosed(text); };
			const pickFiles = async function (period, event) {
				const files = event.target && event.target.files;
				if (!files || files.length === 0) return;
				const file = files[0];
				if (file.size > MAX_UPLOAD_BYTES) { setError("文件超过 100MB，请先压缩（源代码文件夹请打包为 .zip）"); if (event.target) event.target.value = ""; return; }
				setUploading(period);
				setError("");
				setStatus("正在上传并解析：" + file.name + "…");
				try {
					const data = await readFileAsBase64(file);
					const result = await apiCall("/upload-file", { period: period, name: file.name, base64: data });
					if (!result || !result.ok) throw new Error((result && result.error) || "上传失败");
					setUploads(function (current) {
						const next = {};
						next[period] = current[period].concat([{ id: result.id, name: result.name, kind: result.kind, fileCount: result.fileCount, chars: result.chars, preview: result.preview || "" }]);
						next[period === "morning" ? "afternoon" : "morning"] = current[period === "morning" ? "afternoon" : "morning"];
						return next;
					});
					setStatus("已上传：" + result.name + (result.kind === "archive" ? "（解压 " + String(result.fileCount) + " 个文件）" : "（文本 " + String(result.chars) + " 字符）"));
					noteIfClosed("已上传：" + result.name);
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
					setStatus("");
					noteIfClosed("上传失败，点击查看详情");
				} finally {
					setUploading("");
					if (event.target) event.target.value = "";
				}
			};
			const removeFile = function (period, id) {
				setUploads(function (current) {
					const next = {};
					next[period] = current[period].filter(function (item) { return item.id !== id; });
					next[period === "morning" ? "afternoon" : "morning"] = current[period === "morning" ? "afternoon" : "morning"];
					return next;
				});
			};
			// Native change listeners: bind the real DOM change event once the
			// panel is open. Only ONE listener path is used (no React onChange)
			// to avoid double-firing races between synthetic and native events.
			pickFilesRef.current = pickFiles;
			react.useEffect(function () {
				if (!open) return;
				const handlers = {};
				["morning", "afternoon"].forEach(function (period) {
					const node = fileInputs.current[period];
					if (node === undefined || node === null) return;
					const handler = function (event) { const fn = pickFilesRef.current; if (fn) fn(period, event); };
					node.addEventListener("change", handler);
					handlers[period] = { node: node, handler: handler };
				});
				return function () {
					for (const key of Object.keys(handlers)) {
						const h = handlers[key];
						h.node.removeEventListener("change", h.handler);
					}
				};
			}, [open]);
			const material = function (title, key, period) {
				return react.createElement("label", { className: "drp-box" },
					react.createElement("strong", null, title),
					react.createElement("small", null, "可混合输入学习文档、代码源码和会议纪要；也可上传文档文件或源代码文件夹压缩包"),
					react.createElement("div", { className: "drp-upload" },
						react.createElement("div", { className: "drp-upload-title" },
							react.createElement("span", null, "📎"),
							react.createElement("span", null, "上传文档 / 源码文件夹压缩包（.zip，单个 ≤100MB）")),
						react.createElement("input", { type: "file", className: "drp-file-input", ref: function (node) { fileInputs.current[period] = node; }, accept: ".zip,.docx,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.h,.cpp,.cs,.go,.rs,.sql,.html,.css,.scss,.xml,.yaml,.yml,.toml,.ini,.sh,.ps1,.vue,.php,.rb,.swift,.kt,.properties" }),
						uploads[period].length > 0 ? react.createElement("div", { className: "drp-file-list" }, uploads[period].map(function (item) {
							return react.createElement("div", { key: item.id, className: "drp-file-item" },
								react.createElement("span", null, item.name + (item.kind === "archive" ? "（" + String(item.fileCount) + " 个文件）" : "（" + String(item.chars) + " 字符）")),
								react.createElement("button", { type: "button", className: "drp-file-remove", onClick: function () { removeFile(period, item.id); } }, "移除"),
								item.preview ? react.createElement("span", { className: "drp-file-preview" }, "解析预览：" + item.preview) : null);
						})) : null),
					react.createElement("textarea", { className: "drp-textarea", value: form[key], onChange: function (event) { setForm(function (current) { const next = Object.assign({}, current); next[key] = event.target.value; return next; }); }, placeholder: "【会议纪要】", maxLength: 90000 }));
			};
			const generate = async function () {
				setBusy(true);
				setError("");
				setStatus("正在生成日报和 Word 文档…");
				try {
					const result = await apiCall("/generate-report", Object.assign({}, form, {
						morningUploadIds: uploads.morning.map(function (item) { return item.id; }),
						afternoonUploadIds: uploads.afternoon.map(function (item) { return item.id; }),
					}));
					if (!result || !result.ok) throw new Error((result && result.error) || "生成失败");
					setGenerated(result);
					setStatus("已生成：" + result.file.relativePath);
					noteIfClosed("日报已生成，点击查看");
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
					setStatus("");
					noteIfClosed("生成失败，点击查看详情");
				} finally {
					setBusy(false);
				}
			};
			const send = async function () {
				if (!generated) return;
				if (!recipient.trim()) { setError("请填写钉钉好友姓名"); return; }
				setSending(true);
				setError("");
				setStatus("正在唯一解析好友并发送附件…");
				try {
					const result = await apiCall("/send-report", { id: generated.id, recipient: recipient.trim() });
					if (!result || !result.ok) throw new Error((result && result.error) || "发送失败");
					setStatus("发送请求已完成，请在钉钉确认。");
					noteIfClosed("已发送到钉钉");
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
					setStatus("");
					noteIfClosed("发送失败，点击查看详情");
				} finally {
					setSending(false);
				}
			};
			const href = generated ? "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," + generated.file.downloadBase64 : "";
			// Background pill (only while the panel is closed): shows an in-flight
			// operation with a spinner, or a completion notice when a task settled
			// while the user was away. Clicking it reopens the panel.
			const opRunning = busy || !!uploading || sending;
			const pill = (!open && (opRunning || doneClosed))
				? react.createElement("button", { type: "button", className: "drp-activity" + (opRunning ? " drp-activity-running" : " drp-activity-done"), title: "打开日报助手", onClick: function () { window.__drpSetOpen(true); } },
					opRunning ? react.createElement("span", { className: "drp-spinner" }) : null,
					react.createElement("span", { className: "drp-activity-text" },
						opRunning ? (status || "处理中…") : ("✓ " + (doneClosed || "已完成") + "，点击查看")))
				: null;
			const overlay = open
				? react.createElement("div", { className: "drp-overlay" },
					react.createElement("div", { className: "drp-mask", onClick: function () { window.__drpSetOpen(false); } }),
					react.createElement("section", { className: "drp-panel", role: "dialog", "aria-modal": "true", "aria-label": "日报助手" },
						react.createElement("header", { className: "drp-head" },
							react.createElement("div", null,
								react.createElement("h1", null, "日报助手"),
								react.createElement("p", null, "一个帮助工作者完成日报的插件，支持根据学习文档、源代码与会议纪要的上传与内容总结")),
							react.createElement("button", { type: "button", className: "drp-close", "aria-label": "关闭", title: opRunning ? "关闭面板，任务将在后台继续" : "关闭", onClick: function () { window.__drpSetOpen(false); } }, "×")),
						react.createElement("div", { className: "drp-boxes" },
							material("上午素材", "morningMaterials", "morning"),
							material("下午素材", "afternoonMaterials", "afternoon")),
						react.createElement("div", { className: "drp-actions" },
							react.createElement("button", { type: "button", className: "drp-btn drp-primary", disabled: busy || sending || !!uploading, onClick: generate }, busy ? "生成中…" : "生成 Word 日报"),
							react.createElement("label", { className: "drp-field" },
								react.createElement("span", null, "钉钉好友姓名"),
								react.createElement("input", { className: "drp-input", value: recipient, onChange: function (event) { setRecipient(event.target.value); }, placeholder: "输入姓名；歧义时停止" })),
							react.createElement("button", { type: "button", className: "drp-btn drp-secondary", disabled: !generated || busy || sending || !!uploading, onClick: send }, sending ? "发送中…" : "发送到钉钉")),
						react.createElement("p", { className: "drp-bg-hint" }, "上传 / 生成 / 发送进行中可随时点 × 关闭：任务会在后台继续，完成后点击右下角胶囊查看结果。"),
						status ? react.createElement("div", { className: "drp-status" }, status) : null,
						error ? react.createElement("div", { className: "drp-status drp-error", role: "alert" }, error) : null,
						generated ? react.createElement("article", { className: "drp-preview" },
							react.createElement("h2", null, "1. 今日完成工作"),
							react.createElement("p", null, generated.report.todayCompleted),
							react.createElement("h2", null, "2. 明日计划"),
							react.createElement("p", null, generated.report.tomorrowPlan),
							react.createElement("h2", null, "3. 感悟总结"),
							react.createElement("p", null, generated.report.insights),
							react.createElement("a", { className: "drp-download", href: href, download: generated.file.date + "-日报.docx" }, "下载 Word 文档")) : null))
				: null;
			return react.createElement(react.Fragment, null, pill, overlay);
		}

		function apply(ctx) {
			try {
				const style = document.createElement("style");
				style.setAttribute("data-dsh-daily-report-css", "");
				style.textContent = CSS;
				document.head.appendChild(style);
				window.__drpSetOpen = function (value) {
					if (window.__drpSetOpenListener) window.__drpSetOpenListener(value);
				};
				const rootEl = document.createElement("div");
				rootEl.setAttribute("data-dsh-daily-report-root", "");
				document.body.appendChild(rootEl);
				const root = react_dom_client.createRoot(rootEl);
				const toggle = function () {
					const listener = window.__drpSetOpenListener;
					if (listener) listener(true);
					else window.__drpSetOpen(true);
				};
				window.__drpToggle = toggle;
				root.render(react.createElement(Overlay, null));
				mountSidebar(toggle);
				mountFloating(toggle);
			} catch (error) {
				console.error("[dsh-daily-report] apply failed", error);
			}
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
