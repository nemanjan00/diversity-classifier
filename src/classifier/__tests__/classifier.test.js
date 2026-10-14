const createPatterns = require("../../patterns").createPatterns;
const createClassifiers = require("../index").createClassifiers;
const serialise = require("../index").serialise;

const setup = () => {
	const patterns = createPatterns();
	patterns.defineParser({ name: "head", template: "^{ts:timestamp} {level:level}" });
	return { patterns, classifiers: createClassifiers(patterns) };
};

const rec = (raw, source) => {
	return { raw, source: source || "s" };
};

describe("classifiers", () => {
	test("first matching top-level classifier by priority wins", () => {
		const s = setup();
		s.classifiers.define({ name: "generic", template: "user {u:word} {action:word}" });
		s.classifiers.define({ name: "login", template: "user {u:word} login", priority: 10 });

		expect(s.classifiers.classify(rec("user bob login")).node.name).toBe("login");
		expect(s.classifiers.classify(rec("user bob logout")).node.name).toBe("generic");
		expect(s.classifiers.classify(rec("nothing"))).toBeNull();
	});

	test("sub-classifiers refine on a parent field and merge fields", () => {
		const s = setup();
		s.classifiers.define({ name: "http", template: "{method:word} {path:path} {status:int}" });
		s.classifiers.define({ name: "http.admin", parent: "http", on: "path", template: "^/admin/{section:word}" });

		const admin = s.classifiers.classify(rec("GET /admin/users 200"));
		expect(admin.path).toEqual(["http", "http.admin"]);
		expect(admin.fields).toMatchObject({ method: "GET", status: 200, section: "users" });

		const plain = s.classifiers.classify(rec("GET /api/x 200"));
		expect(plain.path).toEqual(["http"]);
		expect(plain.classified).toBe(true);
	});

	test("envelope-only matches are unclassified with body", () => {
		const s = setup();
		s.classifiers.define({ name: "app", template: "{...head} {msg:rest}", envelope: true, time_field: "ts" });
		s.classifiers.define({ name: "app.hello", parent: "app", template: "hello {who:word}" });

		const hit = s.classifiers.classify(rec("2026-10-14T12:00:00Z INFO hello world"));
		expect(hit.classified).toBe(true);
		expect(hit.fields).toMatchObject({ level: "info", who: "world" });
		expect(hit.time).toBe(Date.parse("2026-10-14T12:00:00Z"));

		const miss = s.classifiers.classify(rec("2026-10-14T12:00:00Z INFO something else"));
		expect(miss.classified).toBe(false);
		expect(miss.envelope.name).toBe("app");
		expect(miss.body).toBe("something else");
	});

	test("source scoping", () => {
		const s = setup();
		s.classifiers.define({ name: "only-api", template: "ping", sources: ["api-*"] });
		expect(s.classifiers.classify(rec("ping", "api-1"))).not.toBeNull();
		expect(s.classifiers.classify(rec("ping", "db"))).toBeNull();
	});

	test("validation: envelope body, missing parent, store levels", () => {
		const s = setup();
		expect(() => {
			s.classifiers.define({ name: "env", template: "{...head}", envelope: true });
		}).toThrow(/body field 'msg'/);
		expect(() => {
			s.classifiers.define({ name: "orphan", parent: "nope", template: "x" });
		}).toThrow(/does not exist/);
		expect(() => {
			s.classifiers.define({ name: "bad", template: "x", store: "maybe" });
		}).toThrow(/store/);
		expect(s.classifiers.nodes().length).toBe(0);
	});

	test("lenient define keeps broken definitions disabled with an error", () => {
		const s = setup();
		s.classifiers.define({ name: "broken", template: "{x:missing_parser}" }, true);
		expect(s.classifiers.get("broken").error).toMatch(/Unknown type/);
		expect(s.classifiers.classify(rec("anything"))).toBeNull();
	});

	test("resolve selectors with globs include descendants; remove drops subtree", () => {
		const s = setup();
		s.classifiers.define({ name: "a", template: "a {x:int}" });
		s.classifiers.define({ name: "a.b", parent: "a", template: "1" });
		s.classifiers.define({ name: "c", template: "c" });

		expect(s.classifiers.resolve("a").sort()).toEqual(["a", "a.b"]);
		expect(s.classifiers.resolve("*").length).toBe(3);
		expect(s.classifiers.remove("a").sort()).toEqual(["a", "a.b"]);
		expect(s.classifiers.nodes().map((node) => {
			return node.name;
		})).toEqual(["c"]);
	});

	test("serialise drops defaults", () => {
		const s = setup();
		const def = s.classifiers.define({ name: "x", template: "x" });
		expect(serialise(def)).toEqual({ name: "x", template: "x" });
	});
});
