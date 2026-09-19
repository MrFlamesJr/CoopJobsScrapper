take a good look at this project. it was heaviliy vibe coded so theres alot of wrong stuff. I want you to launch a bunch of smaller subagents that will go back to you for feedback to fix all the problems.

first: the selleniun should be directly inside the server, not a seperate process.

the scrapper actually mixes up data sometimes, please debug and fix.

cleanup the code and use best practices.

the ui should be masivvly imporved and be convertted to dark mode, minimalistic. the ui should be a grid of expandable components (expand to see more dettails) only most important info on the cover (including title, how long, deadline (with color code and formated as "closed yesterday", closing today, closuing tomowrw , closing december 21...) the location, job number... all in a nintreseting layout

the database should creat views(? im not sure thats the right trhign) but basically they would be all the different things you can sort by so it compiles a list of all the options for all the properties (obviously only those that could repeate so not description . it should be entirely searchable finding any that has the search word. the filters should be cumulative with an easy clear fliters

the ui of the filters should always be visible (sidebar?) where ever you are so it doenst disapear when you scroll. prioritize and maximiz the amout of jobs you can see at a time keeping them well redable and not crowded.

improve the scrapper hook in the webapp to work properly and to monitor the scrapping properly (also the status checks, the if the DB is already populated force the user to explicitly delete it before continuing) 

imporve the connecting to the scrapping broweser to do the authentication the noVCN (or whaterver its called) is not great.

when im talkjing about go practices, still keep in mind that this is a small project so ecverything should be kept simple and intuitive as well


make sure you (fable) dont use too many credits. leave the more credit heavy tasks to the cheaper subagents. be cost efficient but generate intelligent and proper content.