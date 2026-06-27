

// ════════════════════════════════════════════════════════════════════════════
// DESKTOP SIDEBAR COLLAPSE — toggle + localStorage persistence
// Only active on screens > 768px. Mobile is handled by setupMobileNav() above.
// Appended as part of Phase 1 Responsive UI Refactor.
// ════════════════════════════════════════════════════════════════════════════

(function setupDesktopSidebarCollapse() {
  const STORAGE_KEY   = "bm_sidebar_collapsed";
  const DESKTOP_MIN   = 769; // px — below this, collapse state is irrelevant

  function isDesktop() {
    return window.innerWidth >= DESKTOP_MIN;
  }

  function applyCollapsed(sidebar, content, collapsed) {
    if (collapsed) {
      sidebar.classList.add("bm-sidebar-collapsed");
      content.classList.add("bm-content-shifted");
      toggleBtn.setAttribute("aria-label", "Expand sidebar");
      toggleBtn.setAttribute("title", "Expand sidebar");
    } else {
      sidebar.classList.remove("bm-sidebar-collapsed");
      content.classList.remove("bm-content-shifted");
      toggleBtn.setAttribute("aria-label", "Collapse sidebar");
      toggleBtn.setAttribute("title", "Collapse sidebar");
    }
  }

  var toggleBtn; // declared here so applyCollapsed can reference it

  function init() {
    const sidebar  = document.getElementById("bm-sidebar");
    const content  = document.querySelector(".main-content");
    toggleBtn      = document.getElementById("bm-sidebar-toggle");

    if (!sidebar || !content || !toggleBtn) return;

    // Restore saved state (desktop only — don't apply collapsed on first mobile load)
    const savedCollapsed = localStorage.getItem(STORAGE_KEY) === "true";
    if (isDesktop() && savedCollapsed) {
      applyCollapsed(sidebar, content, true);
    }

    // Toggle on button click
    toggleBtn.addEventListener("click", function () {
      const isNowCollapsed = !sidebar.classList.contains("bm-sidebar-collapsed");
      applyCollapsed(sidebar, content, isNowCollapsed);
      localStorage.setItem(STORAGE_KEY, isNowCollapsed);
    });

    // On resize: if user goes to mobile, clear collapsed visual state
    // (mobile sidebar is handled by its own IIFE; collapse doesn't apply there)
    let resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!isDesktop()) {
          // Remove collapsed classes on mobile — mobile has its own layout
          sidebar.classList.remove("bm-sidebar-collapsed");
          content.classList.remove("bm-content-shifted");
        } else {
          // Restore saved preference when returning to desktop
          const saved = localStorage.getItem(STORAGE_KEY) === "true";
          applyCollapsed(sidebar, content, saved);
        }
      }, 100);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
