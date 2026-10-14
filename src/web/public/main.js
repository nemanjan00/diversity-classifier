import { mount, Toaster } from "@nemanjan00/qrp-shadcdn";
import { startUrlSync } from "./lib/view.js";
import { startLive } from "./lib/live.js";
import { Shell, initTheme } from "./lib/shell.js";
import { ClassifierEditor } from "./lib/editor.js";
import { DiscoverPage } from "./pages/discover.js";
import { ClassifiersPage } from "./pages/classifiers.js";
import { UnclassifiedPage } from "./pages/unclassified.js";
import { VisualizePage } from "./pages/visualize.js";
import { DashboardsPage } from "./pages/dashboards.js";
import { OpsPage } from "./pages/ops.js";

const PAGES = {
	discover: DiscoverPage,
	classifiers: ClassifiersPage,
	unclassified: UnclassifiedPage,
	visualize: VisualizePage,
	dashboards: DashboardsPage,
	ops: OpsPage
};

initTheme();
startUrlSync();
startLive();

mount(document.getElementById("app"), () => {
	return Shell(PAGES, ClassifierEditor);
});

mount(document.getElementById("toasts"), () => {
	return Toaster({ position: "bottom-right", richColors: true, closeButton: true });
});
