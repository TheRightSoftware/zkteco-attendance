import { Router } from "express";
import { transactionRouter } from "./transaction.routes";

export const routes: Router = Router();

routes.use("/", transactionRouter);
