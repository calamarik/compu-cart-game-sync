import React from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { Index } from "../../src/routes/index";
import "@fontsource/press-start-2p/latin-400.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "../../src/styles.css";

const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Index });
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory({ initialEntries: ["/"] }) });
const root = document.getElementById("root");
if (root) createRoot(root).render(<RouterProvider router={router} />);