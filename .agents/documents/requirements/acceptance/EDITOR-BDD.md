# BDD Scenarios — Editor (Gherkin)

## Feature: Open Vault

```gherkin
Feature: Open Vault
  As a user
  I want to open a folder as a vault
  So that I can browse and edit markdown files

  Scenario: Open a valid vault
    Given the app is running
    When I click "Open Vault"
    And I select a folder containing .md files
    Then the file tree loads in the sidebar
    And the status bar shows the vault name
    And the welcome screen is replaced by the editor layout

  Scenario: Open a folder with no markdown files
    Given the app is running
    When I click "Open Vault"
    And I select an empty folder
    Then the sidebar shows "Empty vault"
    And a "Create Note" button is displayed
```

## Feature: Edit Markdown

```gherkin
Feature: Edit Markdown
  As a writer
  I want to edit markdown files with live preview
  So that I can see the rendered output in real time

  Scenario: Edit a markdown file
    Given I have a file open in the editor
    When I type markdown content
    Then CodeMirror shows syntax highlighting
    And the preview updates within 200ms

  Scenario: Open a large file (>1MB)
    Given a file larger than 1MB exists in the vault
    When I open that file
    Then a "Large file" warning is displayed
    And syntax highlighting is disabled
```

## Feature: Wiki Links

```gherkin
Feature: Wiki Links
  As a note-taker
  I want to link notes using [[wikilinks]]
  So that I can navigate between related notes

  Scenario: Create a wikilink with autocomplete
    Given I am editing a markdown file
    When I type "[["
    Then an autocomplete popup appears within 200ms
    And it shows matching note titles from the vault

  Scenario: Navigate via wikilink
    Given the document contains [[another-note]]
    When I click the wikilink
    Then "another-note.md" opens in the editor
```

## Feature: Git Push

```gherkin
Feature: Git Push
  As a project user
  I want to push changes to git
  So that my documentation is published via CI

  Scenario: Push with changes
    Given the vault has a docu.json
    And there are uncommitted changes
    When I click "Push to Publish"
    Then git add, commit, and push execute
    And the status shows "Pushed successfully"

  Scenario: Push with no changes
    Given there are no uncommitted changes
    When I click "Push to Publish"
    Then I see "Nothing to push"
    And the button is disabled
```

## Feature: Full-text Search

```gherkin
Feature: Full-text Search
  As a knowledge worker
  I want to search across all notes in my vault
  So that I can find information quickly

  Scenario: Search with results
    Given the vault has indexed notes
    When I type a query with 2+ characters
    Then search results appear within 500ms
    And each result shows title and snippet

  Scenario: Search with no results
    Given there are no matching notes
    When I search for a unique string
    Then "No results found" is displayed
```

## Feature: AI Assistant

```gherkin
Feature: AI Assistant
  As a writer
  I want to get AI help on selected text
  So that I can improve my writing

  Scenario: Ask AI with internet connection
    Given I have selected text in the editor
    When I trigger "Ask AI"
    Then a streaming response appears in the overlay
    And I can Accept, Modify, or Reject the result

  Scenario: Ask AI without connection
    Given there is no internet connection
    When I trigger "Ask AI"
    Then "No connection" error is shown
```
