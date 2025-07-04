import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from "sequelize-typescript";

export interface UserI {
  id?: number;
  username?: string;
  email?: string;
  phone?: string;
  password?: string;
  profile?: string;
  bio?: string;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date;
  statusId?: number;
  OTP?: number;
  forgotPassOTP?: number;
  isOtpUsed?: boolean;
  isForgotPassOtpUsed?: boolean;
  otpCreatedAt?: Date;
  forgotPassOtpCreatedAt?: Date;
}

@Table({
  modelName: "user",
  tableName: "user",
  timestamps: true,
  paranoid: true,
  defaultScope: {
    attributes: { exclude: [""] },
  },
})
export class User extends Model<UserI> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  public id!: number;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    // unique: true,
    validate: {
      isEmail: true,
    },
  })
  public email!: string;

  @Column({
    type: DataType.STRING,
    allowNull: true,
  })
  public password!: string;


  @Column(DataType.INTEGER)
  public statusId: number;

  @Column({
    type: DataType.VIRTUAL,
    get() {
      return getStatusName(this.getDataValue("statusId"));
    },
  })
  public statusName: string;

  @Column(DataType.STRING)
  public username: string;

  @Column(DataType.STRING)
  public phone: string;

  @Column(DataType.STRING)
  public bio: string;

  @Column(DataType.STRING)
  public profile: string;

  @Column(DataType.INTEGER)
  public OTP: number;

  @Column(DataType.INTEGER)
  public forgotPassOTP: number;

  @Column({
    type: DataType.TINYINT,
    defaultValue: false,
  })
  public isOtpUsed: boolean;

  @Column({
    type: DataType.TINYINT,
    defaultValue: false,
  })
  public isForgotPassOtpUsed: boolean;

  @Column(DataType.DATE)
  public otpCreatedAt: Date;

  @Column(DataType.DATE)
  public forgotPassOtpCreatedAt: Date;
}

const getStatusName = (type: any) => {
  if (type === 1) return "Pending Email Verification";
  if (type === 2) return "Active";
  if (type === 3) return "Deleted";
  return "";
};