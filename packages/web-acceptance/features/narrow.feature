@narrow
Feature: A narrow viewport hides nothing
  # 380 px, which is on the far side of the 44 rem breakpoint `styles.css`
  # reflows at rather than near it. The assertions are about GEOMETRY, not about
  # class names: a media query that stopped applying would leave every class
  # exactly where it was, so a test that read classes would go on passing over a
  # board scrolling sideways.

  Scenario: The board reflows rather than scrolling sideways
    Given a settled red run of the failing fixture
    And I open the board
    Then the page does not scroll sideways
    And every run row's scope and attention are within the viewport

  Scenario: The run detail stacks its two panels
    Given a settled red run of the failing fixture
    And I open that run
    Then the nodes and the output are stacked, not side by side
    And the page does not scroll sideways
