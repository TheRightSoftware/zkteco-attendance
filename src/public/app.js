document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements
  const filtersForm = document.getElementById("filters-form");
  const startDateInput = document.getElementById("start-date");
  const endDateInput = document.getElementById("end-date");
  const empCodeInput = document.getElementById("emp-code");
  const nameSearchInput = document.getElementById("name-search");
  const btnFetch = document.getElementById("btn-fetch");
  const btnXlsx = document.getElementById("btn-xlsx");
  const btnPdf = document.getElementById("btn-pdf");

  const loader = document.getElementById("loader");
  const emptyState = document.getElementById("empty-state");
  const navigationTabs = document.getElementById("navigation-tabs");
  const tabLogs = document.getElementById("tab-logs");
  const tabWeekly = document.getElementById("tab-weekly");
  const tabMonthly = document.getElementById("tab-monthly");
  const tabPeriod = document.getElementById("tab-period");
  const logsTbody = document.getElementById("logs-tbody");
  const logCountBadge = document.getElementById("log-count");

  // Global state for holding fetched data
  let fetchedData = null;

  // Initialize with default date values (First day of current month to today)
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  
  startDateInput.value = firstDay.toISOString().split("T")[0];
  endDateInput.value = today.toISOString().split("T")[0];

  // Tab switching logic
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      // Avoid breaking if we click a sub-tab button
      if (btn.classList.contains("sub-tab-btn")) return;

      // Remove active classes
      tabBtns.forEach(b => {
        if (!b.classList.contains("sub-tab-btn")) {
          b.classList.remove("active");
        }
      });
      document.querySelectorAll(".tab-content").forEach(tc => tc.style.display = "none");

      // Add active class to clicked button
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      document.getElementById(targetId).style.display = "block";
    });
  });

  // Fetch Attendance Action
  filtersForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const start = startDateInput.value;
    const end = endDateInput.value;

    if (!start || !end) {
      alert("Please select both start and end dates.");
      return;
    }

    // Update UI states
    btnFetch.disabled = true;
    btnFetch.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Fetching...`;
    btnXlsx.disabled = true;
    btnPdf.disabled = true;
    
    loader.style.display = "flex";
    emptyState.style.display = "none";
    navigationTabs.style.display = "none";
    tabLogs.style.display = "none";
    tabWeekly.style.display = "none";
    tabMonthly.style.display = "none";
    tabPeriod.style.display = "none";

    try {
      // Fetch all records for the period (no empCode/name in API call to cache it locally)
      let queryUrl = `/api/getMergedAttendanceReport?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

      console.log("📡 Querying:", queryUrl);
      const res = await fetch(queryUrl);
      const data = await res.json();

      if (data.statusCode !== 200) {
        throw new Error(data.message || "Failed to fetch attendance data.");
      }

      fetchedData = data.response;

      if (!fetchedData.records || fetchedData.records.length === 0) {
        showEmptyState("No records found", "There are no attendance logs matching the filters specified.");
        return;
      }

      // Filter and populate UI locally
      filterAndPopulateUI();

    } catch (err) {
      console.error(err);
      showEmptyState("Error Loading Data", err.message || "Something went wrong while communicating with the server.");
    } finally {
      btnFetch.disabled = false;
      btnFetch.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i> Fetching Records`;
      loader.style.display = "none";
    }
  });

  // Local filtering listeners
  empCodeInput.addEventListener("input", () => {
    filterAndPopulateUI();
  });
  nameSearchInput.addEventListener("input", () => {
    filterAndPopulateUI();
  });

  // Export to Excel trigger
  btnXlsx.addEventListener("click", () => {
    const start = startDateInput.value;
    const end = endDateInput.value;
    const empCode = empCodeInput.value.trim();

    let exportUrl = `/api/exportMergedAttendanceReport?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    if (empCode) {
      exportUrl += `&empCode=${encodeURIComponent(empCode)}`;
    }
    
    window.open(exportUrl, "_blank");
  });

  // Export to PDF trigger
  btnPdf.addEventListener("click", () => {
    if (!fetchedData || !fetchedData.records || fetchedData.records.length === 0) return;
    generatePDFReport();
  });

  // In-memory Filter and Populate Logic
  function filterAndPopulateUI() {
    if (!fetchedData) return;

    const empCode = empCodeInput.value.trim().toLowerCase();
    const nameSearch = nameSearchInput.value.trim().toLowerCase();

    // Filter main logs
    let filteredRecords = fetchedData.records;
    if (empCode) {
      filteredRecords = filteredRecords.filter(row => 
        String(row["Employee Code"]).toLowerCase().includes(empCode)
      );
    }
    if (nameSearch) {
      filteredRecords = filteredRecords.filter(row => 
        String(row["Name"] || "").toLowerCase().includes(nameSearch)
      );
    }

    if (filteredRecords.length === 0) {
      // Empty filtered table
      logsTbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-secondary);">No matches found for specified filter.</td></tr>`;
      logCountBadge.textContent = "0 rows";
      tabWeekly.innerHTML = `<div class="empty-card"><p>No summaries match the filtered constraints.</p></div>`;
      tabMonthly.innerHTML = `<div class="empty-card"><p>No summaries match the filtered constraints.</p></div>`;
      tabPeriod.innerHTML = `<div class="empty-card"><p>No summaries match the filtered constraints.</p></div>`;
      return;
    }

    // Get set of lowercase names matching the filtered employees
    const matchedNames = new Set(filteredRecords.map(r => r.Name?.trim().toLowerCase()).filter(Boolean));

    // Filter weekly, monthly, period summary lists
    const filterSummaryGroups = (groups) => {
      if (!groups) return [];
      return groups.map(group => {
        const filteredRows = group.rows.filter(row => 
          matchedNames.has(row.Name?.trim().toLowerCase())
        );
        return {
          ...group,
          rows: filteredRows
        };
      }).filter(group => group.rows.length > 0);
    };

    const filteredSummaries = {
      weekly: filterSummaryGroups(fetchedData.summaries.weekly),
      monthly: filterSummaryGroups(fetchedData.summaries.monthly),
      fullPeriod: filterSummaryGroups(fetchedData.summaries.fullPeriod)
    };

    // Render Logs Table with Total Time in the LAST column and dynamic coloring
    logsTbody.innerHTML = "";
    filteredRecords.forEach(row => {
      const totalWorkTime = row["Total Work Time"] || "-";
      const totalTimeClass = totalWorkTime === "-" ? "" : (isEightHoursOrMore(totalWorkTime) ? "text-green" : "text-red");
      
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row["Employee Code"] || "-"}</td>
        <td><strong>${row["Name"] || "-"}</strong></td>
        <td>${row["Date"] || "-"}</td>
        <td>${row["Check In"] || "-"}</td>
        <td>${row["Check Out"] || "-"}</td>
        <td>${row["Office Work Time"] || "-"}</td>
        <td>${row["Clockify Worked Hours"] || "-"}</td>
        <td>${row["Total Break Time"] || "-"}</td>
        <td>${row["Total Washroom Time"] || "-"}</td>
        <td class="${totalTimeClass}"><strong>${totalWorkTime}</strong></td>
      `;
      logsTbody.appendChild(tr);
    });

    logCountBadge.textContent = `${filteredRecords.length} records`;

    // Populate summaries with dynamic sub-tabs
    populateWeeklySummaryTab(tabWeekly, filteredSummaries.weekly, "Weekly Attendance Summaries");
    populateMonthlySummaryTab(tabMonthly, filteredSummaries.monthly, "Monthly Attendance Summaries");
    
    // Populate period summary (remains list view since it's just 1 full period sheet)
    populateSummaryTab(tabPeriod, filteredSummaries.fullPeriod, "Full Period Attendance Summaries");

    // Reveal elements
    emptyState.style.display = "none";
    navigationTabs.style.display = "block";

    // Find active tab and trigger its display
    const activeTabBtn = document.querySelector(".tab-btn.active:not(.sub-tab-btn)");
    if (activeTabBtn) {
      const targetId = activeTabBtn.getAttribute("data-tab");
      document.getElementById(targetId).style.display = "block";
    } else {
      // Fallback: click first button
      tabBtns[0]?.click();
    }
    
    // Enable export downloads
    btnXlsx.disabled = false;
    btnPdf.disabled = false;
  }

  // Specialized Weekly tab renderer allowing switching between week sub-tabs
  function populateWeeklySummaryTab(tabContainer, summaryGroups, mainTitle) {
    tabContainer.innerHTML = `<h2 class="summary-period-title">${mainTitle}</h2>`;
    
    if (!summaryGroups || summaryGroups.length === 0) {
      tabContainer.innerHTML += `<div class="empty-card"><p>No summaries available for this timeframe.</p></div>`;
      return;
    }

    // sub-tabs bar
    const subTabNav = document.createElement("div");
    subTabNav.className = "tab-container glass";
    subTabNav.style.display = "flex";
    subTabNav.style.gap = "0.25rem";
    subTabNav.style.padding = "0.25rem";
    subTabNav.style.marginBottom = "1.5rem";
    subTabNav.style.overflowX = "auto";
    
    const weeksContentContainer = document.createElement("div");
    weeksContentContainer.className = "weeks-content-container";

    summaryGroups.forEach((group, index) => {
      // Week Tab Button
      const subTabBtn = document.createElement("button");
      subTabBtn.className = `tab-btn sub-tab-btn ${index === 0 ? "active" : ""}`;
      subTabBtn.style.flex = "none";
      subTabBtn.style.minWidth = "160px";
      
      let displayName = group.sheetName;
      const match = group.sheetName.match(/week-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})/);
      if (match) {
        const s = match[1].substring(5); // MM-DD
        const e = match[2].substring(5); // MM-DD
        displayName = `Week: ${s} to ${e}`;
      }
      
      subTabBtn.innerHTML = `<i class="fa-regular fa-calendar-check"></i> ${displayName}`;
      subTabBtn.setAttribute("data-week-index", index);
      
      // Week Cards Content
      const card = document.createElement("div");
      card.className = "table-card glass week-card-content";
      card.id = `week-content-${index}`;
      card.style.display = index === 0 ? "block" : "none";
      
      card.innerHTML = `
        <div class="table-header">
          <h3>${group.sheetName}</h3>
          <span class="badge">${group.rows.length} users</span>
        </div>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Total Office Work Time</th>
                <th>Total Break Time</th>
                <th>Total Washroom Time</th>
                <th>Total Clockify Time</th>
                <th>Total Combined Work Time</th>
              </tr>
            </thead>
            <tbody>
              ${group.rows.map(row => {
                const totalWorkTime = row["Total Work Time"] || "-";
                const totalTimeClass = totalWorkTime === "-" ? "" : (isEightHoursOrMore(totalWorkTime) ? "text-green" : "text-red");
                return `
                  <tr>
                    <td><strong>${row.Name || "-"}</strong></td>
                    <td>${row["Total Office Work Time"] || "-"}</td>
                    <td>${row["Total Break Time"] || "-"}</td>
                    <td>${row["Total Washroom Time"] || "-"}</td>
                    <td>${row["Total Clockify Time"] || "-"}</td>
                    <td class="${totalTimeClass}"><strong>${totalWorkTime}</strong></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
      
      subTabBtn.addEventListener("click", () => {
        subTabNav.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
        subTabBtn.classList.add("active");
        
        weeksContentContainer.querySelectorAll(".week-card-content").forEach(c => c.style.display = "none");
        card.style.display = "block";
      });

      subTabNav.appendChild(subTabBtn);
      weeksContentContainer.appendChild(card);
    });

    tabContainer.appendChild(subTabNav);
    tabContainer.appendChild(weeksContentContainer);
  }

  // Specialized Monthly tab renderer allowing switching between month sub-tabs
  function populateMonthlySummaryTab(tabContainer, summaryGroups, mainTitle) {
    tabContainer.innerHTML = `<h2 class="summary-period-title">${mainTitle}</h2>`;
    
    if (!summaryGroups || summaryGroups.length === 0) {
      tabContainer.innerHTML += `<div class="empty-card"><p>No summaries available for this timeframe.</p></div>`;
      return;
    }

    // sub-tabs bar
    const subTabNav = document.createElement("div");
    subTabNav.className = "tab-container glass";
    subTabNav.style.display = "flex";
    subTabNav.style.gap = "0.25rem";
    subTabNav.style.padding = "0.25rem";
    subTabNav.style.marginBottom = "1.5rem";
    subTabNav.style.overflowX = "auto";
    
    const monthsContentContainer = document.createElement("div");
    monthsContentContainer.className = "months-content-container";

    summaryGroups.forEach((group, index) => {
      // Month Tab Button
      const subTabBtn = document.createElement("button");
      subTabBtn.className = `tab-btn sub-tab-btn ${index === 0 ? "active" : ""}`;
      subTabBtn.style.flex = "none";
      subTabBtn.style.minWidth = "160px";
      
      let displayName = group.sheetName;
      const match = group.sheetName.match(/month-(\d{4})-(\d{2})/);
      if (match) {
        const year = match[1];
        const monthNum = parseInt(match[2], 10);
        const monthNames = [
          "January", "February", "March", "April", "May", "June", 
          "July", "August", "September", "October", "November", "December"
        ];
        const monthName = monthNames[monthNum - 1] || match[2];
        displayName = `${monthName} ${year}`;
      }
      
      subTabBtn.innerHTML = `<i class="fa-regular fa-calendar"></i> ${displayName}`;
      subTabBtn.setAttribute("data-month-index", index);
      
      // Month Cards Content
      const card = document.createElement("div");
      card.className = "table-card glass month-card-content";
      card.id = `month-content-${index}`;
      card.style.display = index === 0 ? "block" : "none";
      
      card.innerHTML = `
        <div class="table-header">
          <h3>${group.sheetName}</h3>
          <span class="badge">${group.rows.length} users</span>
        </div>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Total Office Work Time</th>
                <th>Total Break Time</th>
                <th>Total Washroom Time</th>
                <th>Total Clockify Time</th>
                <th>Total Combined Work Time</th>
              </tr>
            </thead>
            <tbody>
              ${group.rows.map(row => {
                const totalWorkTime = row["Total Work Time"] || "-";
                const totalTimeClass = totalWorkTime === "-" ? "" : (isEightHoursOrMore(totalWorkTime) ? "text-green" : "text-red");
                return `
                  <tr>
                    <td><strong>${row.Name || "-"}</strong></td>
                    <td>${row["Total Office Work Time"] || "-"}</td>
                    <td>${row["Total Break Time"] || "-"}</td>
                    <td>${row["Total Washroom Time"] || "-"}</td>
                    <td>${row["Total Clockify Time"] || "-"}</td>
                    <td class="${totalTimeClass}"><strong>${totalWorkTime}</strong></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
      
      subTabBtn.addEventListener("click", () => {
        subTabNav.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
        subTabBtn.classList.add("active");
        
        monthsContentContainer.querySelectorAll(".month-card-content").forEach(c => c.style.display = "none");
        card.style.display = "block";
      });

      subTabNav.appendChild(subTabBtn);
      monthsContentContainer.appendChild(card);
    });

    tabContainer.appendChild(subTabNav);
    tabContainer.appendChild(monthsContentContainer);
  }

  function populateSummaryTab(tabContainer, summaryGroups, mainTitle) {
    tabContainer.innerHTML = `<h2 class="summary-period-title">${mainTitle}</h2>`;
    
    if (!summaryGroups || summaryGroups.length === 0) {
      tabContainer.innerHTML += `<div class="empty-card"><p>No summaries available for this timeframe.</p></div>`;
      return;
    }

    const groupsContainer = document.createElement("div");
    groupsContainer.className = "summary-tables-container";

    summaryGroups.forEach(group => {
      const card = document.createElement("div");
      card.className = "table-card glass";
      card.style.marginBottom = "1.5rem";

      card.innerHTML = `
        <div class="table-header">
          <h3>${group.sheetName}</h3>
          <span class="badge">${group.rows.length} users</span>
        </div>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Total Office Work Time</th>
                <th>Total Break Time</th>
                <th>Total Washroom Time</th>
                <th>Total Clockify Time</th>
                <th>Total Combined Work Time</th>
              </tr>
            </thead>
            <tbody>
              ${group.rows.map(row => {
                const totalWorkTime = row["Total Work Time"] || "-";
                const totalTimeClass = totalWorkTime === "-" ? "" : (isEightHoursOrMore(totalWorkTime) ? "text-green" : "text-red");
                return `
                  <tr>
                    <td><strong>${row.Name || "-"}</strong></td>
                    <td>${row["Total Office Work Time"] || "-"}</td>
                    <td>${row["Total Break Time"] || "-"}</td>
                    <td>${row["Total Washroom Time"] || "-"}</td>
                    <td>${row["Total Clockify Time"] || "-"}</td>
                    <td class="${totalTimeClass}"><strong>${totalWorkTime}</strong></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
      groupsContainer.appendChild(card);
    });

    tabContainer.appendChild(groupsContainer);
  }

  function showEmptyState(title, subtitle) {
    emptyState.querySelector("h2").textContent = title;
    emptyState.querySelector("p").textContent = subtitle;
    emptyState.style.display = "flex";
    navigationTabs.style.display = "none";
    tabLogs.style.display = "none";
    tabWeekly.style.display = "none";
    tabMonthly.style.display = "none";
    tabPeriod.style.display = "none";
  }

  // Client-Side PDF Generation using jsPDF-AutoTable
  function generatePDFReport() {
    const { jsPDF } = window.jspdf;
    
    // Create landscape document
    const doc = new jsPDF({
      orientation: "landscape",
      unit: "mm",
      format: "a4"
    });

    const start = startDateInput.value;
    const end = endDateInput.value;
    const empCode = empCodeInput.value.trim().toLowerCase();
    const nameSearch = nameSearchInput.value.trim().toLowerCase();

    // Get current filtered list of records matching filters
    let recordsToExport = fetchedData.records;
    if (empCode) {
      recordsToExport = recordsToExport.filter(row => 
        String(row["Employee Code"]).toLowerCase().includes(empCode)
      );
    }
    if (nameSearch) {
      recordsToExport = recordsToExport.filter(row => 
        String(row["Name"] || "").toLowerCase().includes(nameSearch)
      );
    }

    // 1. Header Styling
    doc.setFillColor(99, 102, 241); // indigo primary color
    doc.rect(0, 0, 297, 26, "F");

    doc.setTextColor(255, 255, 255);
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(18);
    doc.text("ATTENDANCE ANALYTICS REPORT", 14, 11);
    
    doc.setFont("Helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`Report Period: ${start} to ${end} ${empCode ? ` | Employee ID: ${empCode}` : ""} ${nameSearch ? ` | Name: ${nameSearch}` : ""}`, 14, 17);
    doc.text(`Generated At: ${new Date().toLocaleString()}`, 14, 22);

    // 2. Render Table starting directly below the header (no KPI cards in PDF)
    const tableColumns = [
      "Code",
      "Name",
      "Date",
      "In",
      "Out",
      "Office Hrs",
      "Clockify Hrs",
      "Breaks",
      "Washroom",
      "Total Hrs"
    ];

    const tableRows = recordsToExport.map(row => [
      row["Employee Code"] || "",
      row["Name"] || "",
      row["Date"] || "",
      row["Check In"] || "",
      row["Check Out"] || "",
      row["Office Work Time"] || "",
      row["Clockify Worked Hours"] || "",
      row["Total Break Time"] || "",
      row["Total Washroom Time"] || "",
      row["Total Work Time"] || ""
    ]);

    doc.autoTable({
      head: [tableColumns],
      body: tableRows,
      startY: 32, // Start directly below the header banner
      theme: "striped",
      headStyles: {
        fillColor: [39, 39, 42],
        textColor: [255, 255, 255],
        fontSize: 8,
        fontStyle: "bold",
        halign: "left"
      },
      bodyStyles: {
        fontSize: 8,
        textColor: [63, 63, 70]
      },
      columnStyles: {
        0: { cellWidth: 15 },
        1: { cellWidth: 40, fontStyle: "bold" },
        2: { cellWidth: 22 },
        3: { cellWidth: 22 },
        4: { cellWidth: 22 },
        5: { cellWidth: 22 },
        6: { cellWidth: 22 },
        7: { cellWidth: 22 },
        8: { cellWidth: 22 },
        9: { cellWidth: 22 } // Styles configured in didParseCell
      },
      margin: { left: 14, right: 14 },
      didParseCell: function(data) {
        // Highlight total work time column (index 9) dynamically
        if (data.section === 'body' && data.column.index === 9) {
          const val = data.cell.raw;
          if (val && val !== "-") {
            if (isEightHoursOrMore(String(val))) {
              data.cell.styles.textColor = [16, 124, 65]; // Green: hex #107C41
              data.cell.styles.fontStyle = 'bold';
            } else {
              data.cell.styles.textColor = [220, 38, 38]; // Red: hex #DC2626
              data.cell.styles.fontStyle = 'bold';
            }
          }
        }
      },
      didDrawPage: function(data) {
        // Footer: Page Numbering
        doc.setFont("Helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(161, 161, 170);
        const str = "Page " + doc.internal.getNumberOfPages();
        doc.text(str, 297 - 14 - doc.getTextWidth(str), 210 - 10);
        doc.text("Attendance Analytics Report - Confidential", 14, 210 - 10);
      }
    });

    const filePrefix = empCode ? `attendance_report_${empCode}` : "attendance_report_summary";
    doc.save(`${filePrefix}_${start}_to_${end}.pdf`);
  }
});

// Standalone Helper to determine if a formatted work time string is 8 hours or more
function isEightHoursOrMore(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return false;
  timeStr = timeStr.trim();
  
  // Format hh:mm (e.g. 08:28, 120:15)
  if (timeStr.includes(":")) {
    const [h, m] = timeStr.split(":").map(Number);
    return h >= 8;
  }
  
  // Format "Xh Ym" (e.g. 10h 3m)
  const match = timeStr.match(/^(\d+)\s*h/i);
  if (match) {
    const h = parseInt(match[1], 10);
    return h >= 8;
  }
  
  return false;
}
