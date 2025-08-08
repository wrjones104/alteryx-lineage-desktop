# Alteryx Lineage Visualizer - Usage Guide

This guide explains how to use the Alteryx Lineage Viewer desktop application to map and understand your Alteryx workflows.

## Getting Started: Workspaces

The application's data is stored in a workspace, which is a single `.sqlite` file. This file can be stored on your local machine or on a shared network drive for team collaboration.

When you first launch the application, you will be greeted with a welcome screen with three options:

* **Create New Workspace:** Opens a "Save" dialog to create a new, empty `.sqlite` file.
* **Open Existing Workspace:** Opens a file browser to select a pre-existing `.sqlite` file.
* **Recent Workspaces:** Provides a list of your 5 most recently used workspaces for quick access.

You can also access these options from the **File** menu at any time.

## The Main Interface

Once a workspace is open, you are presented with the main interface. You can switch between three main views using the buttons in the top navigation bar:

* **Graph View:** The primary, interactive visualization of your data lineage.
* **Report View:** A detailed, list-based view of all workflows and their specific inputs and outputs.
* **Impact View:** A ranked table showing the "Criticality Score" of each workflow.

### Adding, Inspecting, and Deleting Workflows

* **Adding Workflows:** Click the **Add Workflow** button in the top navigation to open a modal. You can then either drag-and-drop your `.yxmd` files into the box or click the box to open a file browser.
* **Inspecting Nodes:** In the **Graph View**, click on any node (a workflow or a data source) to open the **Node Inspector**. This pop-up shows a summary of that node's direct inputs and outputs.
* **Creating Aliases:** When inspecting a data source node, you can provide a user-friendly **Alias** (e.g., "Centric CRM Source") to replace a long or cryptic file path. This alias will be used throughout the application.
* **Deleting Workflows:** You can delete a workflow from two places:
    1.  In the **Report View**, by clicking the trash can icon on the workflow's card.
    2.  In the **Graph View**, by clicking a workflow node to open the Node Inspector and then clicking the trash can icon.
    *A confirmation prompt will require you to type "DELETE" to prevent accidental deletion.*

### The Impact Analysis View

The Impact Analysis view is designed to help you identify the most critical workflows in your ecosystem. It displays a ranked table with three columns:

* **Rank:** The workflow's rank, from most to least critical.
* **Workflow Name:** The name of the `.yxmd` file.
* **Criticality Score:** A number representing the workflow's total "blast radius." It is the count of every unique data source and workflow that depends on this workflow's outputs, directly or indirectly. A higher score means a failure in this workflow will have a larger ripple effect.

In the **Actions** column, you can click **Graph** or **Report** to immediately jump to that specific workflow in the corresponding view.

### Handling Complex Alteryx Tools (Advanced)

Some Alteryx tools, like the **Download Tool** or the **Python Tool**, don't write their inputs and outputs to the workflow's XML in a standard way. The parser cannot automatically detect them. To solve this, you can manually define the inputs and outputs for **any tool** by adding a special block of text to its **Annotation** box in Alteryx.

#### The `lineage` Annotation Syntax

The block must start with `--- lineage ---` and end with `---`. The available types are `File`, `Database`, and `API`.

```yaml
--- lineage ---
inputs:
  - type: Database
    path: odbc:DSN=MySpecialDB
  - type: File
    path: \\server\share\some_input_file.csv
outputs:
  - type: API
    path: [https://api.service.com/endpoint](https://api.service.com/endpoint)
  - type: File
    path: C:\outputs\my_output.yxdb
---