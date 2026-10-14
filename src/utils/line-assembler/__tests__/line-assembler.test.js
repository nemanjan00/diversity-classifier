const createLineSplitter = require("../index").createLineSplitter;
const createAssembler = require("../index").createAssembler;

describe("line splitter", () => {
	test("splits across chunks and strips CR", () => {
		const lines = [];
		const splitter = createLineSplitter((line) => {
			lines.push(line);
		}, 1000);
		splitter.push(Buffer.from("one\r\ntw"));
		splitter.push(Buffer.from("o\nthree"));
		splitter.end();
		expect(lines).toEqual(["one", "two", "three"]);
	});
});

describe("assembler", () => {
	test("emits single lines, strips ANSI and skips blanks", () => {
		const records = [];
		const assembler = createAssembler({
			onRecord: (record) => {
				records.push(record);
			}
		});
		assembler.push("\u001b[31merror\u001b[0m here");
		assembler.push("   ");
		expect(records).toEqual(["error here"]);
	});

	test("joins continuation lines with a start regex", () => {
		const records = [];
		const assembler = createAssembler({
			multiline: { start: "^\\d{4}-" },
			onRecord: (record) => {
				records.push(record);
			}
		});
		assembler.push("2026-10-14 boom");
		assembler.push("  at a()");
		assembler.push("  at b()");
		assembler.push("2026-10-14 next");
		assembler.flush();
		expect(records).toEqual(["2026-10-14 boom\n  at a()\n  at b()", "2026-10-14 next"]);
	});

	test("joins with a continue regex", () => {
		const records = [];
		const assembler = createAssembler({
			multiline: { continue: "^\\s" },
			onRecord: (record) => {
				records.push(record);
			}
		});
		assembler.push("Traceback:");
		assembler.push("  File x");
		assembler.push("ValueError");
		assembler.flush();
		expect(records).toEqual(["Traceback:\n  File x", "ValueError"]);
	});
});
