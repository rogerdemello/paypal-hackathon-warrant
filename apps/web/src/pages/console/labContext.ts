import { createContext, useContext } from 'react';

/** Whether the console also shows what Dispute Lab scenarios created. Off by default: the console is for the shop's own activity. */
export const ShowLabContext = createContext<boolean>(false);
export const useShowLab = (): boolean => useContext(ShowLabContext);
