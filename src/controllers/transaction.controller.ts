import { TransactionService } from "@src/services/transaction.service";
import { Request, Response } from "express";
import * as XLSX from "xlsx";

export class TransactionController {
  /**
   * @param __service
   */

  public constructor(public __service: TransactionService) {}
  /**
   *
   * @param req
   * @param res
   * @param next
   */

  public fetchTransactions = async (req: Request, res: Response) => {
    try {
      let message = "Transactions fetched successfully.";
      const response: any = await this.__service.fetchTransactions();

      res.status(200).json({
        statusCode: 200,
        message,
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public getJWTToken = async (req: Request, res: Response) => {
    try {
      const { query } = req;
      const response: any = await this.__service.getJWTToken(query);
      res.status(200).json({
        statusCode: 200,
        message: "JWT Token fetched successfully.",
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public getClockify = async (req: Request, res: Response) => {
    try {
      const { query } = req;
      const response: any = await this.__service.getClockify();
      res.status(200).json({
        statusCode: 200,
        message: "Data fetched successfully.",
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public getRocketChatUsers = async (req: Request, res: Response) => {
    try {
      const response: any = await this.__service.getRocketChatUsers();
      res.status(200).json({
        statusCode: 200,
        message: "Rocket.Chat users fetched successfully.",
        count: response.length,
        users: response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public exportRocketChatUsers = async (req: Request, res: Response) => {
    try {
      const { workbook, fileName }: any = await this.__service.exportRocketChatUsers();

      const buffer = XLSX.write(workbook, {
        bookType: "xlsx",
        type: "buffer",
      });

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.send(buffer);
    } catch (error: any) {
      console.log(error);
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public getAllUsersAttendance = async (req: Request, res: Response) => {
    try {
      const { query } = req;
      const response: any = await this.__service.getAllUsersAttendance(query);
      res.status(200).json({
        statusCode: 200,
        message: "Data fetched successfully.",
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public exportAttendanceReport = async (req: Request, res: Response) => {
    try {
      const response: any = await this.__service.exportAttendanceReport();
      res.status(200).json({
        statusCode: 200,
        message: "Data fetched successfully.",
        response,
      });
    } catch (error: any) {
      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };

  public exportMergedAttendanceReport = async (req: Request, res: Response) => {
    try {
      const { query } = req;
      const { workbook, fileName }: any =
        await this.__service.exportMergedAttendanceReport(query);

      const buffer = XLSX.write(workbook, {
        bookType: "xlsx",
        type: "buffer",
      });

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.send(buffer);

      // res.status(200).json({
      //   statusCode: 200,
      //   message: "Data fetched successfully.",
      // });
    } catch (error: any) {
      console.log(error);

      res.status(403).send({
        statusCode: 403,
        message: error.message,
      });
    }
  };
}
