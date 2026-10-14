import {
	state, el, when, batch, effect, toast,
	Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
	Button, Input, Textarea, Label, Switch, Badge, NativeSelect, NativeSelectOption, Separator
} from "@nemanjan00/qrp-shadcdn";
import { api } from "./api.js";
import { view, refresh, go, formatValue } from "./view.js";
import { live } from "./live.js";
import { resource } from "./resource.js";

/*
 * Classifier editor (Sheet): template with live capture highlighting, the
 * definition options, Test (dry run with near-miss diagnosis) and Save
 * (define_classifier, reporting how much of the queue it absorbed).
 */

const blank = () => {
	return {
		name: "",
		template: "",
		description: "",
		parent: "",
		on: "",
		envelope: false,
		body: "msg",
		priority: 0,
		store: "full",
		scope: "project",
		time_field: "",
		lines: ""
	};
};

export const editor = state({
	open: false,
	editing: false,
	cluster: null,
	def: blank(),
	test: null,
	testing: false,
	saving: false,
	error: null
});

/**
 * Open the editor.
 * @param {object} [def] initial definition (template, parent, name, ...)
 * @param {{ cluster?: string, editing?: boolean }} [opts]
 */
export const openEditor = (def, opts) => {
	const o = opts || {};
	const base = blank();
	const next = Object.assign(base, def || {});
	["parent", "on", "time_field", "description"].forEach((key) => {
		if (next[key] === null || next[key] === undefined) {
			next[key] = "";
		}
	});

	batch(() => {
		Object.keys(next).forEach((key) => {
			editor.def[key] = next[key];
		});
		editor.cluster = o.cluster || null;
		editor.editing = !!o.editing;
		editor.test = null;
		editor.error = null;
		editor.open = true;
	});
};

const CAPTURE_RE = /\{\{|\}\}|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;

/** Render a template with captures highlighted. */
export const templateView = (template) => {
	const text = template || "";
	const parts = [];
	let last = 0;
	let m = CAPTURE_RE.exec(text);

	while (m) {
		if (m.index > last) {
			parts.push(text.slice(last, m.index));
		}

		if (m[0] === "{{" || m[0] === "}}") {
			parts.push(m[0][0]);
		} else {
			const body = m[0].slice(1, -1);
			const colon = body.indexOf(":");
			const name = colon === -1 ? body : body.slice(0, colon);
			const type = colon === -1 ? "word" : body.slice(colon + 1);
			parts.push(el("span", { class: "dc-cap", title: m[0] }, el("span", { class: "dc-cap-name" }, name), el("span", { class: "dc-cap-type" }, type)));
		}

		last = CAPTURE_RE.lastIndex;
		m = CAPTURE_RE.exec(text);
	}

	CAPTURE_RE.lastIndex = 0;

	if (last < text.length) {
		parts.push(text.slice(last));
	}

	return el("code", { class: "dc-template" }, ...parts);
};

const cleanDef = (d) => {
	const out = { name: d.name.trim(), template: d.template };
	["description", "parent", "on", "time_field"].forEach((key) => {
		if (d[key] && String(d[key]).trim()) {
			out[key] = String(d[key]).trim();
		}
	});

	if (d.envelope) {
		out.envelope = true;
		out.body = d.body || "msg";
	}

	if (Number(d.priority)) {
		out.priority = Number(d.priority);
	}

	if (d.store && d.store !== "full") {
		out.store = d.store;
	}

	if (d.scope && d.scope !== "project") {
		out.scope = d.scope;
	}

	return out;
};

const runTest = () => {
	const args = cleanDef(editor.def);
	const lines = editor.def.lines.split("\n").filter((line) => {
		return line.trim();
	});

	if (lines.length) {
		args.lines = lines;
	} else if (editor.cluster) {
		args.cluster = editor.cluster;
	}

	if (!args.name) {
		delete args.name;
	}

	batch(() => {
		editor.testing = true;
		editor.error = null;
	});

	api("test_classifier", args)
		.then((result) => {
			batch(() => {
				editor.test = result;
				editor.testing = false;
			});
		})
		.catch((error) => {
			batch(() => {
				editor.error = error.message;
				editor.testing = false;
			});
		});
};

const save = () => {
	const def = cleanDef(editor.def);

	if (!def.name) {
		editor.error = "Name is required";
		return;
	}

	editor.saving = true;
	api("define_classifier", def)
		.then((result) => {
			const absorbed = result.retro ? result.retro.absorbed : 0;
			toast.success("Saved " + result.classifier, { description: "Absorbed " + absorbed + " queued record(s)" + (result.retro && result.retro.reclustered_under_envelope ? ", re-clustered " + result.retro.reclustered_under_envelope + " under the envelope" : "") });
			batch(() => {
				editor.saving = false;
				editor.open = false;
			});
			refresh();
			go("classifiers", result.classifier);
		})
		.catch((error) => {
			batch(() => {
				editor.error = error.message;
				editor.saving = false;
			});
		});
};

const field = (label, control, hint) => {
	return el("div", { class: "dc-field" }, Label({}, label), control, hint ? el("p", { class: "dc-hint" }, hint) : null);
};

const fieldsTable = (fields) => {
	return el("table", { class: "dc-kv" }, el("tbody", {}, ...Object.keys(fields || {}).map((key) => {
		return el("tr", {}, el("th", {}, key), el("td", {}, formatValue(fields[key])));
	})));
};

const testResults = () => {
	return when(() => {
		return editor.test;
	}, (t) => {
		return el("div", { class: "dc-test" },
			el("div", { class: "dc-test-head" },
				Badge({ variant: t.matched ? "default" : "destructive" }, t.matched + " / " + t.tested + " matched"),
				el("span", { class: "dc-muted" }, t.source),
				t.prefilter_literal ? el("span", { class: "dc-muted" }, "prefilter: “" + t.prefilter_literal + "”") : null),
			el("div", { class: "dc-badges" }, ...Object.keys(t.field_types || {}).map((name) => {
				return Badge({ variant: "outline" }, name + ": " + t.field_types[name]);
			})),
			t.sample_matches && t.sample_matches.length ? el("div", {},
				el("h4", {}, "Sample matches"),
				...t.sample_matches.map((match) => {
					return el("div", { class: "dc-sample" }, el("pre", { class: "dc-raw" }, match.raw), fieldsTable(match.fields));
				})) : null,
			t.near_misses && t.near_misses.length ? el("div", {},
				el("h4", {}, "Near misses"),
				...t.near_misses.map((miss) => {
					const matchedText = miss.matched_text || "";
					const idx = matchedText ? miss.text.indexOf(matchedText) : -1;
					const ok = idx === -1 ? "" : miss.text.slice(0, idx + matchedText.length);
					const rest = idx === -1 ? miss.text : miss.text.slice(idx + matchedText.length);
					return el("div", { class: "dc-sample" },
						el("pre", { class: "dc-raw" }, el("span", { class: "dc-ok" }, ok), el("span", { class: "dc-bad" }, rest)),
						miss.failed_at ? el("p", { class: "dc-hint" }, "fails at ", el("code", {}, miss.failed_at), " after ", el("code", {}, miss.matched_up_to || "(start)")) : null,
						miss.note ? el("p", { class: "dc-hint" }, miss.note) : null);
				})) : null,
			t.parent_did_not_match ? el("p", { class: "dc-hint" }, t.parent_did_not_match.length + " sample(s) did not match the parent chain") : null);
	});
};

/** Mount once in the shell. */
export const ClassifierEditor = () => {
	const d = () => {
		return editor.def;
	};
	const classifiers = resource(() => {
		if (!editor.open) {
			return null;
		}

		live.defRev;
		return api("list_classifiers", {});
	});

	let lastPage = view.page;
	effect(() => {
		if (view.page !== lastPage) {
			lastPage = view.page;
			editor.open = false;
		}
	});

	return Sheet({ open: [editor, "open"] },
		SheetContent({ side: "right", class: "dc-sheet" },
			SheetHeader(
				SheetTitle(() => {
					return editor.editing ? "Edit classifier" : "New classifier";
				}),
				SheetDescription(() => {
					return editor.cluster ? "From unclassified cluster " + editor.cluster + ". Test runs against that cluster." : "Test runs against the whole unclassified queue (or pasted lines).";
				})),
			el("div", { class: "dc-sheet-body" },
				field("Name", Input({ bind: [editor.def, "name"], placeholder: "app.http", disabled: () => {
					return editor.editing;
				} })),
				field("Template", Textarea({ bind: [editor.def, "template"], rows: 4, class: "dc-mono", spellcheck: false }),
					"{field:type} captures; types: word text rest int float hex bool uuid ip host port url path pathname qs timestamp duration bytes level quoted json kv enum(a,b) regex(..) or a parser; {...head} spreads a parser."),
				() => {
					return d().template ? templateView(d().template) : null;
				},
				el("div", { class: "dc-grid2" },
					field("Parent", NativeSelect({ bind: [editor.def, "parent"] },
						NativeSelectOption({ value: "" }, "(top level)"),
						() => {
							const data = classifiers.data;
							return data ? data.classifiers.map((c) => {
								return NativeSelectOption({ value: c.name, selected: c.name === d().parent }, c.name + (c.envelope ? " (envelope)" : ""));
							}) : null;
						})),
					field("Match on field", Input({ bind: [editor.def, "on"], placeholder: "(raw line / envelope body)" })),
					field("Priority", Input({ type: "number", bind: [editor.def, "priority"] })),
					field("Store", NativeSelect({ bind: [editor.def, "store"] },
						NativeSelectOption({ value: "full" }, "full (fields + raw)"),
						NativeSelectOption({ value: "fields" }, "fields only"),
						NativeSelectOption({ value: "count" }, "count only (noise)"))),
					field("Scope", NativeSelect({ bind: [editor.def, "scope"] },
						NativeSelectOption({ value: "project" }, "project"),
						NativeSelectOption({ value: "global" }, "global"))),
					field("Time field", Input({ bind: [editor.def, "time_field"], placeholder: "ts" }))),
				el("div", { class: "dc-row" },
					Switch({ checked: [editor.def, "envelope"] }),
					Label({}, "Envelope (captures a line head + body; children classify the body)"),
					when(() => {
						return d().envelope;
					}, () => {
						return Input({ bind: [editor.def, "body"], class: "dc-narrow", placeholder: "msg" });
					})),
				field("Description", Input({ bind: [editor.def, "description"] })),
				field("Test lines (optional)", Textarea({ bind: [editor.def, "lines"], rows: 3, class: "dc-mono", placeholder: "Paste sample lines; empty = test against the queue" })),
				when(() => {
					return editor.error;
				}, (message) => {
					return el("div", { class: "dc-error" }, message);
				}),
				Separator(),
				testResults()),
			SheetFooter({ class: "dc-sheet-footer" },
				Button({ variant: "outline", onclick: runTest, disabled: () => {
					return editor.testing || !d().template;
				} }, () => {
					return editor.testing ? "Testing…" : "Test";
				}),
				when(() => {
					return !live.readOnly;
				}, () => {
					return Button({ onclick: save, disabled: () => {
						return editor.saving || !d().template || !d().name;
					} }, () => {
						return editor.saving ? "Saving…" : "Save";
					});
				}))));
};
