The repo https://github.com/luca-randazzo/chiara-speech2text is public, with one branch `main`.
This private repo was created to enable working on (git-controlled) changes,
without pushing to the public repo if not needed. 

The following instructions were followed: https://stackoverflow.com/questions/7983204/having-a-private-branch-of-a-public-repo-on-github 

Sepcifcially, this repo has been created as follows:
-   Duplicated public repo https://github.com/luca-randazzo/chiara-speech2text

    Using these instructions: https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository 

-   Made the newly duplicated repo private on GitHub

-   Cloned private repo to a local machine

-   In this local clone of the private repo:
    - Added a remote (named `public`) which points to the public repo, using command:

        `git remote add "public" https://github.com/luca-randazzo/chiara-speech2text.git`

-   Once remote is created, changes can be pushed to it -when one wants- with:

    `git push public main`


Remotes can be listed with: `git remote -v`