---
"phoebe-agent": patch
---

On the setup page, Start Docker and Install Docker spin from the click until Docker answers, and the page clears itself to home the moment it does. The sentences about permission prompts, Docker Desktop's start-up time and "waiting for Docker to answer" are gone. When Docker still has not answered after two minutes the button comes back with a line saying what to check, and the page keeps asking on its own every fifteen seconds while it is open. A bootstrap exit now goes out a second time with `settled` once that wait ends.
