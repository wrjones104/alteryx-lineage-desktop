# Alteryx Lineage Viewer - Usage Guide

This guide explains how to use the Alteryx Lineage Viewer desktop application to map and understand your Alteryx workflows.

## Getting Started: Workspaces

The application's data is stored in a workspace, which is a single `.sqlite` file. This file can be stored on your local machine or on a shared network drive for team collaboration.

When you first launch the application, you will be greeted with a welcome screen with three options:

* **Create New Workspace:** Opens a "Save" dialog to create a new, empty `.sqlite` file.
* **Open Existing Workspace:** Opens a file browser to select a pre-existing `.sqlite` file.
* **Recent Workspaces:** Provides a list of your 5 most recently used workspaces for quick access.

You can also access these options from the **File** menu at any time.

## The Main Interface

Once a workspace is open, you are presented with the main interface:
* **Top Navigation Bar:** Contains all the main controls, such as adding new workflows and switching between views.
* **Graph View:** The primary, interactive visualization of your data lineage.
* **Report View:** A detailed, list-based view of all workflows and their specific inputs and outputs.

## Adding & Inspecting Workflows

* **Adding Workflows:** Click the "Add Workflow" button in the top navigation to open a modal. You can then either drag-and-drop your `.yxmd` files into the box or click the box to open a file browser.
* **Inspecting Nodes:** In the Graph View, click on any node (a workflow or a data source) to open the **Node Inspector**. This pop-up shows a summary of that node's direct inputs and outputs.
* **Creating Aliases:** When inspecting a data source node, you can provide a user-friendly **Alias** (e.g., "Centric CRM Source") to replace a long or cryptic file path or connection string. This alias will be used in both the Graph and Report views.

## Handling Complex Alteryx Tools (Advanced)

Some Alteryx tools, like the **Download Tool** or the **Python Tool**, don't write their inputs and outputs to the workflow's XML in a standard way. The parser cannot automatically detect them.

To solve this, you can manually define the inputs and outputs for **any tool** by adding a special block of text to its **Annotation** box in Alteryx.

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